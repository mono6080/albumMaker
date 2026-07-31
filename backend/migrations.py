# 資料庫遷移模組
# 負責在不刪除現有資料的前提下，對資料庫 schema 進行漸進式升級
# 每次新增欄位或資料表時，在此模組追加對應的遷移函式（冪等設計）

import json
import re

from sqlalchemy import text
from sqlalchemy.exc import OperationalError
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
LEGACY_TEACHER_SUPERVISOR_ARCHIVE_TABLE = "legacy_teacher_supervisor_links"
LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE = (
    "legacy_project_classroom_migrations"
)
LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE = (
    "legacy_student_identity_resolutions"
)
LEGACY_PROJECT_IDENTITY_QUARANTINE_TABLE = (
    "legacy_project_identity_quarantines"
)
SEMESTER_REPORTING_MIGRATION_KEY = "organization-reporting-v1"


def _assert_sqlite_can_rewrite_references(connection):
    """改名 migration 依賴 SQLite 自動改寫 FK 與 trigger 內的表名參照。

    3.25 起才會改寫，`legacy_alter_table` 打開時會退回舊行為。任一條不成立時改名
    **不會報錯**，只留下指向舊表名的 FK 與 trigger——所以在這裡先擋下來，而不是照做。
    """
    version = connection.execute(text("SELECT sqlite_version()")).scalar_one()
    version_info = tuple(int(part) for part in version.split("."))
    if version_info < (3, 25, 0):
        raise RuntimeError(
            f"SQLite {version} 不會在改名時改寫 FK 與 trigger 參照，需要 3.25 以上"
        )
    if connection.execute(text("PRAGMA legacy_alter_table")).scalar_one():
        raise RuntimeError(
            "PRAGMA legacy_alter_table 已開啟，改名會留下指向舊表名的參照"
        )


TABLE_RENAMES = (
    ("class_roster_members", "classroom_members"),
    ("classroom_teacher_assignments", "classroom_teachers"),
    ("academic_terms", "semesters"),
    ("academic_term_periods", "semester_periods"),
)

# 欄位改名跟著表名走。三張學期快照表在這一步還在（稍後才 drop），欄位一樣要改，
# 否則後續歷史 migration 的 SQL 找不到欄位。
COLUMN_RENAMES = (
    ("classrooms", "academic_term_id", "semester_id"),
    ("semester_periods", "academic_term_id", "semester_id"),
    ("class_period_work_slots", "term_period_id", "semester_period_id"),
    ("term_reclassification_plans", "target_academic_term_id", "target_semester_id"),
    ("academic_term_classrooms", "academic_term_id", "semester_id"),
    ("academic_term_classroom_students", "academic_term_id", "semester_id"),
)


def _rename_tables_to_model_names(connection):
    """表名與欄位名對齊 model 命名（ClassroomMember／ClassroomTeacher／Semester）。

    改名排在所有 migration 之前：舊資料庫先改名，後續歷史 migration 一律對著新名字
    跑，行為不變；全新資料庫由 init_db() 直接建出新名字，這步是 no-op。
    """
    def existing_tables() -> set[str]:
        return {
            row[0]
            for row in connection.execute(text(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ))
        }

    tables = existing_tables()
    pending_tables = [
        (old, new)
        for old, new in TABLE_RENAMES
        if old in tables and new not in tables
    ]
    pending_columns = [
        (table, old, new)
        for table, old, new in COLUMN_RENAMES
        if table in tables or table in {new for _, new in pending_tables}
    ]
    if not pending_tables and not pending_columns:
        return
    _assert_sqlite_can_rewrite_references(connection)
    for old_name, new_name in pending_tables:
        connection.execute(text(f"ALTER TABLE {old_name} RENAME TO {new_name}"))
    tables = existing_tables()
    for table, old_column, new_column in COLUMN_RENAMES:
        if table not in tables:
            continue
        columns = {
            row[1]
            for row in connection.execute(text(f"PRAGMA table_info({table})"))
        }
        if old_column in columns and new_column not in columns:
            connection.execute(text(
                f"ALTER TABLE {table} RENAME COLUMN {old_column} TO {new_column}"
            ))
    connection.commit()


def run_migrations():
    """執行所有待遷移的 schema 變更，已存在的欄位或資料表會自動跳過。"""
    with engine.connect() as connection:
        _rename_tables_to_model_names(connection)
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
        _add_student_album_name_column(connection)
        _add_organization_structure(connection)
        _add_organization_access_and_reclassification_schema(connection)
        _allow_multiple_term_target_leads(connection)
        _add_organization_supervisor_assignments(connection)
        _quarantine_class_backed_identity_anomalies(connection)
        _add_legacy_project_identity_migration_schema(connection)
        _retire_active_project_editor_assignments(connection)
        _archive_legacy_teacher_supervisor_links(connection)
        _add_semester_reporting_schema(connection)
        _add_roster_child_album_name_column(connection)
        _migrate_assigned_album_names_to_roster_authority(connection)
        _add_student_completed_at_column(connection)
        _migrate_classrooms_to_term_scope(connection)
        _retire_legacy_project_classroom_triggers(connection)
        _add_term_scoped_classroom_indexes(connection)
        _add_term_scoped_classroom_freeze_triggers(connection)


def _retire_legacy_project_classroom_triggers(connection):
    """移除舊相本歸班的 trigger：歸班流程已退場，班級由編班流程指派。

    ledger 表保留為 append-only 稽核資料，只是執行期不再有 trigger 依賴它。
    """
    for trigger_name in (
        "trg_projects_reject_empty_identity_migration",
        "trg_projects_require_identity_migration_ledger",
        "trg_projects_freeze_assigned_classroom",
    ):
        connection.execute(text(f"DROP TRIGGER IF EXISTS {trigger_name}"))
    connection.commit()


def _add_term_scoped_classroom_indexes(connection):
    """學期範圍班級結構的索引，新舊資料庫共用同一份清單。

    組織相關的索引原本建在只跑得到舊結構的 migration 裡，全新資料庫因此少了
    `ux_classroom_members_active_child` 這類唯一鍵。集中在這裡無守衛執行，讓
    init_db() 建出的資料庫與升級上來的資料庫收斂到同一組索引。
    """
    if not _is_term_scoped_classroom_schema(connection):
        return
    # 舊名索引與 ORM 定義重複，語意相同只是命名還帶著已移除的表名
    for legacy_index in (
        "ux_academic_term_classrooms_term_scope_name",
        "idx_academic_term_classrooms_scope",
        "idx_term_classroom_teacher_targets_plan_id",
        # 表名改名前建立的索引，名字仍帶舊表名
        "idx_class_roster_members_classroom_id",
        "idx_class_roster_members_roster_child_id",
        "ux_class_roster_active_child",
        "idx_classroom_teacher_assignments_classroom_id",
        "idx_classroom_teacher_assignments_teacher_id",
        "idx_classroom_teacher_assignments_started_by_id",
        "idx_classroom_teacher_assignments_ended_by_id",
        "ix_class_roster_members_id",
        "ix_classroom_teacher_assignments_id",
        "idx_academic_term_periods_term_id",
        "ix_academic_term_periods_id",
        "ix_academic_terms_id",
        "ux_academic_terms_current",
        "ux_academic_terms_migration_key",
        "ux_term_plans_target_academic_term",
    ):
        connection.execute(text(f"DROP INDEX IF EXISTS {legacy_index}"))
    index_statements = (
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_campuses_name ON campuses(name)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_classrooms_term_scope_name "
        "ON classrooms(semester_id, campus_id, department, name)",
        "CREATE INDEX IF NOT EXISTS idx_classrooms_term_scope "
        "ON classrooms(semester_id, campus_id, department)",
        "CREATE INDEX IF NOT EXISTS idx_classrooms_campus_id ON classrooms(campus_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_members_classroom_id "
        "ON classroom_members(classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_members_roster_child_id "
        "ON classroom_members(roster_child_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_classroom_members_active_child "
        "ON classroom_members(roster_child_id) WHERE ended_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_classroom_teachers_classroom_id "
        "ON classroom_teachers(classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_teachers_teacher_id "
        "ON classroom_teachers(teacher_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_teachers_started_by_id "
        "ON classroom_teachers(started_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_teachers_ended_by_id "
        "ON classroom_teachers(ended_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_projects_classroom_id "
        "ON projects(classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_projects_created_by_id "
        "ON projects(created_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_projects_class_period_work_slot_id "
        "ON projects(class_period_work_slot_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_assignment_history_project_id "
        "ON project_assignment_history(project_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_assignment_history_from_owner_id "
        "ON project_assignment_history(from_owner_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_assignment_history_to_owner_id "
        "ON project_assignment_history(to_owner_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_assignment_history_changed_by_id "
        "ON project_assignment_history(changed_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_editor_assignments_project_id "
        "ON project_editor_assignments(project_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_editor_assignments_user_id "
        "ON project_editor_assignments(user_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_editor_assignments_started_by_id "
        "ON project_editor_assignments(started_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_editor_assignments_ended_by_id "
        "ON project_editor_assignments(ended_by_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_semesters_migration_key "
        "ON semesters(migration_key) WHERE migration_key IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_semester_periods_term_id "
        "ON semester_periods(semester_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_reclassification_plans_created_by_id "
        "ON term_reclassification_plans(created_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_reclassification_plans_updated_by_id "
        "ON term_reclassification_plans(updated_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_reclassification_plans_applied_by_id "
        "ON term_reclassification_plans(applied_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_reclassification_plans_cancelled_by_id "
        "ON term_reclassification_plans(cancelled_by_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_term_plans_target_semester "
        "ON term_reclassification_plans(target_semester_id) "
        "WHERE target_semester_id IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_term_student_placements_plan_id "
        "ON term_student_placements(plan_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_student_placements_source_membership_id "
        "ON term_student_placements(source_membership_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_student_placements_target_classroom_id "
        "ON term_student_placements(target_classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_classroom_plans_plan_id "
        "ON term_classroom_plans(plan_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_classroom_plans_classroom_id "
        "ON term_classroom_plans(classroom_id)",
        "CREATE INDEX IF NOT EXISTS "
        "idx_term_classroom_teacher_targets_classroom_plan_id "
        "ON term_classroom_teacher_targets(classroom_plan_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_classroom_teacher_targets_teacher_id "
        "ON term_classroom_teacher_targets(teacher_id)",
        "CREATE INDEX IF NOT EXISTS ix_class_period_work_slots_id "
        "ON class_period_work_slots(id)",
        "CREATE INDEX IF NOT EXISTS ix_projects_id ON projects(id)",
        "CREATE INDEX IF NOT EXISTS ix_classroom_members_id ON classroom_members(id)",
        "CREATE INDEX IF NOT EXISTS ix_classroom_teachers_id ON classroom_teachers(id)",
        "CREATE INDEX IF NOT EXISTS ix_semesters_id ON semesters(id)",
        "CREATE INDEX IF NOT EXISTS ix_semester_periods_id ON semester_periods(id)",
    )
    for statement in index_statements:
        connection.execute(text(statement))
    connection.commit()


def _add_term_scoped_classroom_freeze_triggers(connection):
    """學期範圍班級結構的不可變保證。

    兩組來源：
    - 相本快照與工作格：判斷條件由 `classroom_id` 改為 `class_period_work_slot_id`
      （見 docs/specs/term-scoped-classroom-v1.md 的 Trigger 調整）。
    - 已結束學期的名冊與編制：接手已移除的兩張學期快照表原本的凍結保證——
      班本身就只活一個學期，學期一關，那學期的成員與編制就是歷史。
    """
    if not _is_term_scoped_classroom_schema(connection):
        return
    for trigger_name in (
        "trg_projects_freeze_classroom_snapshots",
        "trg_projects_freeze_work_slot",
        "trg_work_slots_freeze_identity",
        "trg_work_slots_freeze_started_at",
    ):
        connection.execute(text(f"DROP TRIGGER IF EXISTS {trigger_name}"))
    connection.execute(text("""
        CREATE TRIGGER trg_projects_freeze_classroom_snapshots
        BEFORE UPDATE OF campus_id_snapshot, campus_name_snapshot,
                         classroom_name_snapshot, department ON projects
        WHEN OLD.class_period_work_slot_id IS NOT NULL AND (
            NEW.campus_id_snapshot IS NOT OLD.campus_id_snapshot
            OR NEW.campus_name_snapshot IS NOT OLD.campus_name_snapshot
            OR NEW.classroom_name_snapshot IS NOT OLD.classroom_name_snapshot
            OR NEW.department IS NOT OLD.department
        )
        BEGIN
            SELECT RAISE(ABORT, 'class-backed project snapshots are immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER trg_projects_freeze_work_slot
        BEFORE UPDATE OF class_period_work_slot_id ON projects
        WHEN OLD.class_period_work_slot_id IS NOT NULL
         AND NEW.class_period_work_slot_id IS NOT OLD.class_period_work_slot_id
        BEGIN
            SELECT RAISE(ABORT, 'project work slot is immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER trg_work_slots_freeze_identity
        BEFORE UPDATE OF classroom_id, semester_period_id
        ON class_period_work_slots
        WHEN NEW.classroom_id IS NOT OLD.classroom_id
          OR NEW.semester_period_id IS NOT OLD.semester_period_id
        BEGIN
            SELECT RAISE(ABORT, 'work slot identity is immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER trg_work_slots_freeze_started_at
        BEFORE UPDATE OF started_at ON class_period_work_slots
        WHEN OLD.started_at IS NOT NULL
         AND NEW.started_at IS NOT OLD.started_at
        BEGIN
            SELECT RAISE(ABORT, 'started work slot cannot be reset');
        END
    """))
    for table, trigger_prefix, subject in (
        ("classroom_members", "trg_classroom_members", "roster members"),
        (
            "classroom_teachers",
            "trg_classroom_teachers",
            "teacher assignments",
        ),
    ):
        for operation, row_alias in (
            ("INSERT", "NEW"),
            ("UPDATE", "OLD"),
            ("DELETE", "OLD"),
        ):
            connection.execute(text(f"""
                CREATE TRIGGER IF NOT EXISTS
                {trigger_prefix}_freeze_closed_term_{operation.lower()}
                BEFORE {operation} ON {table}
                WHEN EXISTS (
                    SELECT 1
                    FROM classrooms
                    JOIN semesters AS term
                      ON term.id = classrooms.semester_id
                    WHERE classrooms.id = {row_alias}.classroom_id
                      AND term.status = 'closed'
                )
                BEGIN
                    SELECT RAISE(ABORT, 'closed term {subject} are immutable');
                END
            """))
    connection.commit()


def _is_term_scoped_classroom_schema(connection) -> bool:
    """資料庫是否已是學期範圍班級結構。

    只適用於舊「長期班級 + 學期快照」結構的歷史 migration 一律以此提前返回：
    全新資料庫由 init_db() 直接建出新結構，那些步驟無事可做，硬跑會把已移除的
    快照表重建回來。
    """
    classroom_columns = {
        row[1] for row in connection.execute(text("PRAGMA table_info(classrooms)"))
    }
    return bool(classroom_columns) and "semester_id" in classroom_columns


def _migrate_classrooms_to_term_scope(connection):
    """把長期班級併入學期班級，讓一個班只活一個學期。

    現況是 classrooms 與 academic_term_classrooms 一對一且欄位完全一致（見
    docs/specs/term-scoped-classroom-v1.md 的前提驗證），所以 classrooms.id 原封
    保留、只補上 semester_id；引用班級的 classroom_id 欄位一律不動。

    兩張學期快照表（學生／老師）隨之移除：班本身就只活一個學期，成員與編制的
    live 表就是那個學期的紀錄。
    """
    classroom_columns = {
        row[1] for row in connection.execute(text("PRAGMA table_info(classrooms)"))
    }
    if not classroom_columns or "semester_id" in classroom_columns:
        return

    term_classroom_rows = list(connection.execute(text(
        "SELECT id, semester_id, classroom_id FROM academic_term_classrooms"
    )))
    classroom_ids = [row[0] for row in connection.execute(text(
        "SELECT id FROM classrooms"
    ))]
    term_by_classroom = {row[2]: row[1] for row in term_classroom_rows}
    missing = sorted(set(classroom_ids) - set(term_by_classroom))
    if missing:
        raise RuntimeError(
            f"班級 {missing} 沒有對應的學期班級，無法併入學期範圍；"
            "請先確認每個班都屬於某個正式學期"
        )
    duplicated = len(term_classroom_rows) != len(term_by_classroom)
    if duplicated:
        raise RuntimeError("同一個班對應到多個學期，無法一對一併入")

    connection.execute(text("PRAGMA foreign_keys=OFF"))
    try:
        connection.execute(text(
            "ALTER TABLE classrooms ADD COLUMN semester_id INTEGER "
            "REFERENCES semesters(id)"
        ))
        for classroom_id, semester_id in term_by_classroom.items():
            connection.execute(
                text(
                    "UPDATE classrooms SET semester_id = :term "
                    "WHERE id = :classroom"
                ),
                {"term": semester_id, "classroom": classroom_id},
            )

        # 工作格改指 classrooms.id（原本指 academic_term_classrooms.id）。
        # 兩張表的 id 值域重疊，逐筆 UPDATE 會把前一輪改好的列再改一次，
        # 所以必須一次 join 對應完。
        connection.execute(text("""
            UPDATE class_period_work_slots
            SET term_classroom_id = (
                SELECT term_classroom.classroom_id
                FROM academic_term_classrooms AS term_classroom
                WHERE term_classroom.id = class_period_work_slots.term_classroom_id
            )
        """))
        orphan_slots = connection.execute(text(
            "SELECT COUNT(*) FROM class_period_work_slots "
            "WHERE term_classroom_id IS NULL"
        )).scalar_one()
        if orphan_slots:
            raise RuntimeError(
                f"{orphan_slots} 個工作格對應不到班級，無法併入學期範圍"
            )
        # 整張重建：欄位改名之外，FK 目標也要從即將移除的 academic_term_classrooms
        # 換成 classrooms，兩者都不是 RENAME COLUMN 做得到的。
        connection.execute(text("DROP TABLE IF EXISTS class_period_work_slots_new"))
        connection.execute(text("""
            CREATE TABLE class_period_work_slots_new (
                id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                classroom_id INTEGER NOT NULL
                    REFERENCES classrooms(id) ON DELETE CASCADE,
                semester_period_id INTEGER NOT NULL
                    REFERENCES semester_periods(id) ON DELETE CASCADE,
                started_at DATETIME,
                CONSTRAINT ux_class_period_work_slots_classroom_period
                    UNIQUE (classroom_id, semester_period_id)
            )
        """))
        connection.execute(text(
            "INSERT INTO class_period_work_slots_new "
            "(id, classroom_id, semester_period_id, started_at) "
            "SELECT id, term_classroom_id, semester_period_id, started_at "
            "FROM class_period_work_slots"
        ))
        connection.execute(text("DROP TABLE class_period_work_slots"))
        connection.execute(text(
            "ALTER TABLE class_period_work_slots_new "
            "RENAME TO class_period_work_slots"
        ))

        # 依賴被移除欄位／表的 trigger 必須先卸下，SQLite 不允許帶著它們改結構
        for trigger_name in (
            "trg_projects_reject_empty_identity_migration",
            "trg_projects_require_identity_migration_ledger",
            "trg_projects_freeze_assigned_classroom",
            "trg_semester_students_match_term_insert",
            "trg_semester_students_match_term_update",
            "trg_semester_students_freeze_insert",
            "trg_semester_students_freeze_update",
            "trg_semester_students_freeze_delete",
        ):
            connection.execute(text(f"DROP TRIGGER IF EXISTS {trigger_name}"))

        for index_name in (
            "ux_classrooms_scope_name",
            "ux_academic_term_classrooms_term_classroom",
            "idx_academic_term_classrooms_scope",
        ):
            connection.execute(text(f"DROP INDEX IF EXISTS {index_name}"))

        connection.execute(text("DROP TABLE IF EXISTS academic_term_classroom_students"))
        connection.execute(text("DROP TABLE IF EXISTS academic_term_classroom_teachers"))
        connection.execute(text("DROP TABLE IF EXISTS academic_term_classrooms"))

        # 班級的啟用與時間戳都由所屬學期承擔，欄位一併移除
        for dropped_column in ("is_active", "created_at", "updated_at"):
            connection.execute(text(
                f"ALTER TABLE classrooms DROP COLUMN {dropped_column}"
            ))
        connection.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_classrooms_term_scope_name "
            "ON classrooms(semester_id, campus_id, department, name)"
        ))
        connection.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_classrooms_term_scope "
            "ON classrooms(semester_id, campus_id, department)"
        ))

        # 既有編班草稿的來源 fingerprint 以舊結構算出，套用時必然判定為已變更
        connection.execute(text(
            "UPDATE term_reclassification_plans SET status = 'cancelled' "
            "WHERE status = 'draft'"
        ))
        connection.commit()
    finally:
        connection.execute(text("PRAGMA foreign_keys=ON"))

    violations = list(connection.execute(text("PRAGMA foreign_key_check")))
    if violations:
        raise RuntimeError(f"學期範圍班級遷移後外鍵不一致：{violations[:5]}")


def _add_semester_reporting_schema(connection):
    """加入正式學期、班級期別工作格，並遷移仍有效的已歸班相本。

    學期範圍班級的資料庫只跑得到「建立正式學期」那一段；已移除的學期快照表
    相關 DDL 與回填一律跳過。
    """
    # 舊版曾以 status 本身建 unique index，會允許 imported 與 active 各一筆。
    # 先重建為常數 expression index，讓所有 current 狀態共用唯一鍵；
    # 這與班級結構無關，新舊資料庫都要做，所以排在守衛之前。
    if connection.execute(text(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'semesters'"
    )).first():
        connection.execute(text("DROP INDEX IF EXISTS ux_semesters_current"))
        connection.execute(text(
            "CREATE UNIQUE INDEX ux_semesters_current "
            "ON semesters((1)) WHERE status IN ('imported', 'active')"
        ))
        connection.commit()
    legacy_schema = not _is_term_scoped_classroom_schema(connection)
    if not legacy_schema:
        _backfill_imported_semester(connection)
        return
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS semesters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label VARCHAR NOT NULL,
            status VARCHAR NOT NULL
                CONSTRAINT ck_semesters_status
                CHECK (status IN (
                    'imported', 'draft', 'active', 'closed', 'cancelled'
                )),
            migration_key VARCHAR,
            starts_on DATE,
            ends_on DATE,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            activated_at DATETIME,
            closed_at DATETIME,
            cancelled_at DATETIME,
            created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_by_name_snapshot VARCHAR NOT NULL,
            activated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            activated_by_name_snapshot VARCHAR,
            closed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            closed_by_name_snapshot VARCHAR,
            cancelled_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            cancelled_by_name_snapshot VARCHAR
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS semester_periods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            semester_id INTEGER NOT NULL
                REFERENCES semesters(id) ON DELETE CASCADE,
            template_period_id INTEGER NOT NULL REFERENCES template_periods(id),
            period_name_snapshot VARCHAR NOT NULL,
            department VARCHAR NOT NULL,
            position INTEGER NOT NULL
                CONSTRAINT ck_semester_periods_position CHECK (position >= 0),
            CONSTRAINT ux_semester_periods_term_position
                UNIQUE (semester_id, position),
            CONSTRAINT ux_semester_periods_template_period
                UNIQUE (template_period_id)
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS academic_term_classrooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            semester_id INTEGER NOT NULL
                REFERENCES semesters(id) ON DELETE CASCADE,
            classroom_id INTEGER NOT NULL REFERENCES classrooms(id),
            campus_id_snapshot INTEGER NOT NULL,
            campus_name_snapshot VARCHAR NOT NULL,
            classroom_name_snapshot VARCHAR NOT NULL,
            department VARCHAR NOT NULL,
            CONSTRAINT ux_academic_term_classrooms_term_classroom
                UNIQUE (semester_id, classroom_id)
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS academic_term_classroom_teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            term_classroom_id INTEGER NOT NULL
                REFERENCES academic_term_classrooms(id) ON DELETE CASCADE,
            source_assignment_id INTEGER
                REFERENCES classroom_teachers(id) ON DELETE SET NULL,
            teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            teacher_name_snapshot VARCHAR NOT NULL,
            duty VARCHAR NOT NULL
                CONSTRAINT ck_academic_term_classroom_teachers_duty
                CHECK (duty IN ('lead', 'co_teacher')),
            CONSTRAINT ux_academic_term_classroom_teachers_term_teacher
                UNIQUE (term_classroom_id, teacher_id)
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS academic_term_classroom_students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            semester_id INTEGER NOT NULL
                REFERENCES semesters(id) ON DELETE CASCADE,
            term_classroom_id INTEGER NOT NULL
                REFERENCES academic_term_classrooms(id) ON DELETE CASCADE,
            source_membership_id INTEGER
                REFERENCES classroom_members(id) ON DELETE SET NULL,
            roster_child_id_snapshot INTEGER NOT NULL,
            student_name_snapshot VARCHAR NOT NULL,
            CONSTRAINT ux_academic_term_classroom_students_classroom_child
                UNIQUE (term_classroom_id, roster_child_id_snapshot)
        )
    """))
    # 更早的開發版本曾在 active term 也凍結；先拆除再補欄位，
    # 避免正確的學期 id backfill 被舊 trigger 阻擋。
    for trigger_name in (
        "trg_semester_students_match_term_insert",
        "trg_semester_students_match_term_update",
        "trg_semester_students_freeze_insert",
        "trg_semester_students_freeze_update",
        "trg_semester_students_freeze_delete",
    ):
        connection.execute(text(f"DROP TRIGGER IF EXISTS {trigger_name}"))
    student_snapshot_columns = {
        row[1]
        for row in connection.execute(text(
            "PRAGMA table_info(academic_term_classroom_students)"
        ))
    }
    if "semester_id" not in student_snapshot_columns:
        connection.execute(text(
            "ALTER TABLE academic_term_classroom_students "
            "ADD COLUMN semester_id INTEGER REFERENCES semesters(id)"
        ))
    connection.execute(text("""
        UPDATE academic_term_classroom_students
        SET semester_id = (
            SELECT term_classroom.semester_id
            FROM academic_term_classrooms AS term_classroom
            WHERE term_classroom.id =
                      academic_term_classroom_students.term_classroom_id
        )
        WHERE semester_id IS NULL
    """))
    missing_snapshot_term_ids = [
        row[0]
        for row in connection.execute(text("""
            SELECT id
            FROM academic_term_classroom_students
            WHERE semester_id IS NULL
            ORDER BY id
        """))
    ]
    if missing_snapshot_term_ids:
        raise RuntimeError(
            "學期班級學生快照無法補齊學期："
            f"{missing_snapshot_term_ids[:10]}"
        )
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS class_period_work_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            term_classroom_id INTEGER NOT NULL
                REFERENCES academic_term_classrooms(id) ON DELETE CASCADE,
            semester_period_id INTEGER NOT NULL
                REFERENCES semester_periods(id) ON DELETE CASCADE,
            started_at DATETIME,
            CONSTRAINT ux_class_period_work_slots_classroom_period
                UNIQUE (term_classroom_id, semester_period_id)
        )
    """))

    project_columns = {
        row[1] for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "campus_id_snapshot" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN campus_id_snapshot INTEGER"
        ))
    if "class_period_work_slot_id" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN class_period_work_slot_id INTEGER "
            "REFERENCES class_period_work_slots(id)"
        ))

    plan_columns = {
        row[1]
        for row in connection.execute(text(
            "PRAGMA table_info(term_reclassification_plans)"
        ))
    }
    if "target_semester_id" not in plan_columns:
        connection.execute(text(
            "ALTER TABLE term_reclassification_plans "
            "ADD COLUMN target_semester_id INTEGER "
            "REFERENCES semesters(id)"
        ))

    index_statements = (
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_semesters_migration_key "
        "ON semesters(migration_key) WHERE migration_key IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_semester_periods_term_id "
        "ON semester_periods(semester_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classrooms_term_id "
        "ON academic_term_classrooms(semester_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classrooms_classroom_id "
        "ON academic_term_classrooms(classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classrooms_scope "
        "ON academic_term_classrooms(semester_id, campus_id_snapshot, department)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classroom_teachers_classroom "
        "ON academic_term_classroom_teachers(term_classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classroom_teachers_assignment "
        "ON academic_term_classroom_teachers(source_assignment_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classroom_teachers_teacher "
        "ON academic_term_classroom_teachers(teacher_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classroom_students_classroom "
        "ON academic_term_classroom_students(term_classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classroom_students_term "
        "ON academic_term_classroom_students(semester_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classroom_students_membership "
        "ON academic_term_classroom_students(source_membership_id)",
        "CREATE INDEX IF NOT EXISTS idx_academic_term_classroom_students_child "
        "ON academic_term_classroom_students(roster_child_id_snapshot)",
        "CREATE INDEX IF NOT EXISTS idx_class_period_work_slots_term_classroom "
        "ON class_period_work_slots(term_classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_class_period_work_slots_semester_period "
        "ON class_period_work_slots(semester_period_id)",
        "CREATE INDEX IF NOT EXISTS idx_projects_class_period_work_slot_id "
        "ON projects(class_period_work_slot_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_term_plans_target_semester "
        "ON term_reclassification_plans(target_semester_id) "
        "WHERE target_semester_id IS NOT NULL",
    )
    for statement in index_statements:
        connection.execute(text(statement))
    connection.commit()

    _backfill_project_campus_id_snapshots(connection)
    _backfill_imported_semester(connection)
    connection.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS "
        "ux_academic_term_classroom_students_term_child "
        "ON academic_term_classroom_students("
        "semester_id, roster_child_id_snapshot)"
    ))
    _add_semester_reporting_freeze_triggers(connection)
    connection.commit()


def _backfill_project_campus_id_snapshots(connection):
    """只替仍有效且已歸班相本補校別 id；來源依稽核強度依序採用。"""
    connection.execute(text(f"""
        UPDATE projects
        SET campus_id_snapshot = (
            SELECT migration.target_campus_id_snapshot
            FROM {LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE} AS migration
            WHERE migration.project_id_snapshot = projects.id
        )
        WHERE projects.deleted_at IS NULL
          AND projects.classroom_id IS NOT NULL
          AND projects.campus_id_snapshot IS NULL
          AND EXISTS (
              SELECT 1
              FROM {LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE} AS migration
              WHERE migration.project_id_snapshot = projects.id
          )
    """))
    connection.execute(text("""
        UPDATE projects
        SET campus_id_snapshot = (
            SELECT MIN(campuses.id)
            FROM campuses
            WHERE campuses.name = projects.campus_name_snapshot
        )
        WHERE projects.deleted_at IS NULL
          AND projects.classroom_id IS NOT NULL
          AND projects.campus_id_snapshot IS NULL
          AND projects.campus_name_snapshot IS NOT NULL
          AND (
              SELECT COUNT(*)
              FROM campuses
              WHERE campuses.name = projects.campus_name_snapshot
          ) = 1
    """))
    connection.execute(text("""
        UPDATE projects
        SET campus_id_snapshot = (
            SELECT classrooms.campus_id
            FROM classrooms
            WHERE classrooms.id = projects.classroom_id
        )
        WHERE projects.deleted_at IS NULL
          AND projects.classroom_id IS NOT NULL
          AND projects.campus_id_snapshot IS NULL
    """))
    unresolved_project_ids = [
        row[0]
        for row in connection.execute(text("""
            SELECT id
            FROM projects
            WHERE deleted_at IS NULL
              AND classroom_id IS NOT NULL
              AND campus_id_snapshot IS NULL
            ORDER BY id
        """))
    ]
    if unresolved_project_ids:
        raise RuntimeError(
            "有效相本無法唯一回填校別 id："
            f"{unresolved_project_ids[:10]}"
        )
    connection.commit()


def _backfill_imported_semester(connection):
    """把有效相本與目前 active 期別建立成唯一 imported term 工作格。"""
    connection.execute(
        text("""
            INSERT OR IGNORE INTO semesters (
                label, status, migration_key, created_at,
                created_by_name_snapshot
            ) VALUES (
                '既有資料（遷移）', 'imported', :migration_key,
                CURRENT_TIMESTAMP, '系統遷移'
            )
        """),
        {"migration_key": SEMESTER_REPORTING_MIGRATION_KEY},
    )
    imported_term = connection.execute(
        text("""
            SELECT id, status
            FROM semesters
            WHERE migration_key = :migration_key
        """),
        {"migration_key": SEMESTER_REPORTING_MIGRATION_KEY},
    ).one()
    imported_term_id, imported_status = imported_term
    if imported_status != "imported":
        connection.commit()
        return

    next_position = connection.execute(
        text("""
            SELECT COALESCE(MAX(position), -1) + 1
            FROM semester_periods
            WHERE semester_id = :term_id
        """),
        {"term_id": imported_term_id},
    ).scalar_one()
    period_rows = connection.execute(text("""
        SELECT period.id, period.name, period.department
        FROM template_periods AS period
        WHERE period.status = 'active'
           OR EXISTS (
               SELECT 1
               FROM projects AS project
               WHERE project.template_period_id = period.id
                 AND project.deleted_at IS NULL
                 AND project.classroom_id IS NOT NULL
           )
        ORDER BY period.created_at, period.id
    """))
    for period_id, period_name, department in period_rows:
        existing_term_id = connection.execute(
            text("""
                SELECT semester_id
                FROM semester_periods
                WHERE template_period_id = :period_id
            """),
            {"period_id": period_id},
        ).scalar()
        if existing_term_id is not None:
            continue
        connection.execute(
            text("""
                INSERT INTO semester_periods (
                    semester_id, template_period_id,
                    period_name_snapshot, department, position
                ) VALUES (
                    :term_id, :period_id, :period_name, :department, :position
                )
            """),
            {
                "term_id": imported_term_id,
                "period_id": period_id,
                "period_name": period_name,
                "department": department,
                "position": next_position,
            },
        )
        next_position += 1

    # 班級與工作格的回填只適用於舊結構；學期範圍班級由編班流程建立
    if _is_term_scoped_classroom_schema(connection):
        connection.commit()
        return
    connection.execute(
        text("""
            INSERT OR IGNORE INTO academic_term_classrooms (
                semester_id, classroom_id,
                campus_id_snapshot, campus_name_snapshot,
                classroom_name_snapshot, department
            )
            SELECT :term_id, classroom.id,
                   campus.id, campus.name, classroom.name, classroom.department
            FROM classrooms AS classroom
            JOIN campuses AS campus ON campus.id = classroom.campus_id
            WHERE EXISTS (
                    SELECT 1
                    FROM projects AS project
                    WHERE project.classroom_id = classroom.id
                      AND project.deleted_at IS NULL
                )
               OR (
                    classroom.is_active = 1
                    AND campus.is_active = 1
                    AND EXISTS (
                        SELECT 1
                        FROM template_periods AS period
                        JOIN semester_periods AS semester_period
                          ON semester_period.template_period_id = period.id
                        WHERE semester_period.semester_id = :term_id
                          AND period.status = 'active'
                          AND semester_period.department = classroom.department
                    )
                )
               OR EXISTS (
                    SELECT 1
                    FROM classroom_members AS member
                    WHERE member.classroom_id = classroom.id
                      AND member.ended_at IS NULL
                )
        """),
        {"term_id": imported_term_id},
    )
    connection.execute(
        text("""
            INSERT OR IGNORE INTO academic_term_classroom_teachers (
                term_classroom_id, source_assignment_id, teacher_id,
                teacher_name_snapshot, duty
            )
            SELECT term_classroom.id, assignment.id, assignment.teacher_id,
                   assignment.teacher_name_snapshot, assignment.duty
            FROM academic_term_classrooms AS term_classroom
            JOIN classroom_teachers AS assignment
              ON assignment.classroom_id = term_classroom.classroom_id
            WHERE term_classroom.semester_id = :term_id
              AND assignment.ended_at IS NULL
              AND assignment.teacher_id IS NOT NULL
        """),
        {"term_id": imported_term_id},
    )

    actual_slot_rows = list(connection.execute(text("""
        SELECT term_classroom.id, semester_period.id,
               MIN(COALESCE(project.created_at, CURRENT_TIMESTAMP))
        FROM projects AS project
        JOIN academic_term_classrooms AS term_classroom
          ON term_classroom.classroom_id = project.classroom_id
        JOIN semester_periods AS semester_period
          ON semester_period.template_period_id = project.template_period_id
        WHERE project.deleted_at IS NULL
          AND project.classroom_id IS NOT NULL
          AND term_classroom.semester_id = :term_id
          AND semester_period.semester_id = :term_id
        GROUP BY term_classroom.id, semester_period.id
    """), {"term_id": imported_term_id}))
    for term_classroom_id, semester_period_id, started_at in actual_slot_rows:
        connection.execute(
            text("""
                INSERT OR IGNORE INTO class_period_work_slots (
                    term_classroom_id, semester_period_id, started_at
                ) VALUES (
                    :term_classroom_id, :semester_period_id, :started_at
                )
            """),
            {
                "term_classroom_id": term_classroom_id,
                "semester_period_id": semester_period_id,
                "started_at": started_at,
            },
        )
        connection.execute(
            text("""
                UPDATE class_period_work_slots
                SET started_at = COALESCE(started_at, :started_at)
                WHERE term_classroom_id = :term_classroom_id
                  AND semester_period_id = :semester_period_id
            """),
            {
                "term_classroom_id": term_classroom_id,
                "semester_period_id": semester_period_id,
                "started_at": started_at,
            },
        )

    connection.execute(
        text("""
            INSERT OR IGNORE INTO class_period_work_slots (
                term_classroom_id, semester_period_id, started_at
            )
            SELECT term_classroom.id, semester_period.id, NULL
            FROM academic_term_classrooms AS term_classroom
            JOIN classrooms AS classroom
              ON classroom.id = term_classroom.classroom_id
            JOIN campuses AS campus ON campus.id = classroom.campus_id
            JOIN semester_periods AS semester_period
              ON semester_period.semester_id = term_classroom.semester_id
             AND semester_period.department = term_classroom.department
            JOIN template_periods AS period
              ON period.id = semester_period.template_period_id
            WHERE term_classroom.semester_id = :term_id
              AND classroom.is_active = 1
              AND campus.is_active = 1
              AND period.status = 'active'
        """),
        {"term_id": imported_term_id},
    )
    connection.execute(
        text("""
            UPDATE projects
            SET class_period_work_slot_id = (
                SELECT slot.id
                FROM class_period_work_slots AS slot
                JOIN academic_term_classrooms AS term_classroom
                  ON term_classroom.id = slot.term_classroom_id
                JOIN semester_periods AS semester_period
                  ON semester_period.id = slot.semester_period_id
                WHERE term_classroom.semester_id = :term_id
                  AND term_classroom.classroom_id = projects.classroom_id
                  AND semester_period.template_period_id = projects.template_period_id
            )
            WHERE projects.deleted_at IS NULL
              AND projects.classroom_id IS NOT NULL
              AND projects.class_period_work_slot_id IS NULL
        """),
        {"term_id": imported_term_id},
    )
    unresolved_project_ids = [
        row[0]
        for row in connection.execute(text("""
            SELECT id
            FROM projects
            WHERE deleted_at IS NULL
              AND classroom_id IS NOT NULL
              AND class_period_work_slot_id IS NULL
            ORDER BY id
        """))
    ]
    if unresolved_project_ids:
        raise RuntimeError(
            "有效相本無法遷入班級期別工作格："
            f"{unresolved_project_ids[:10]}"
        )
    _assert_imported_project_scope_snapshots_match(
        connection,
        imported_term_id,
    )
    _sync_imported_semester_student_snapshots(
        connection,
        imported_term_id,
    )
    connection.commit()


def _assert_imported_project_scope_snapshots_match(
    connection,
    imported_term_id: int,
) -> None:
    """拒絕 Project 快照與工作格學期班級快照分裂。"""
    mismatched_project_ids = [
        row[0]
        for row in connection.execute(text("""
            SELECT project.id
            FROM projects AS project
            JOIN class_period_work_slots AS slot
              ON slot.id = project.class_period_work_slot_id
            JOIN academic_term_classrooms AS term_classroom
              ON term_classroom.id = slot.term_classroom_id
            WHERE project.deleted_at IS NULL
              AND project.classroom_id IS NOT NULL
              AND term_classroom.semester_id = :term_id
              AND (
                    project.classroom_id IS NOT term_classroom.classroom_id
                 OR project.campus_id_snapshot IS NOT
                        term_classroom.campus_id_snapshot
                 OR project.campus_name_snapshot IS NOT
                        term_classroom.campus_name_snapshot
                 OR project.classroom_name_snapshot IS NOT
                        term_classroom.classroom_name_snapshot
                 OR project.department IS NOT term_classroom.department
              )
            ORDER BY project.id
        """), {"term_id": imported_term_id})
    ]
    if mismatched_project_ids:
        raise RuntimeError(
            "有效相本與學期班級快照不一致："
            f"{mismatched_project_ids[:10]}"
        )


def _sync_imported_semester_student_snapshots(
    connection,
    imported_term_id: int,
) -> None:
    """以目前名單為權威，用有效相本補齊遷移前已離班學生。"""
    connection.execute(text(
        "DROP TABLE IF EXISTS temp_imported_term_student_snapshot_desired"
    ))
    connection.execute(text("""
        CREATE TEMP TABLE temp_imported_term_student_snapshot_desired (
            roster_child_id_snapshot INTEGER PRIMARY KEY,
            term_classroom_id INTEGER NOT NULL,
            source_membership_id INTEGER,
            student_name_snapshot VARCHAR NOT NULL
        )
    """))

    # 沒有目前名單時，最新一本有效相本是最後班級的可追溯證據。
    connection.execute(text("""
        INSERT INTO temp_imported_term_student_snapshot_desired (
            roster_child_id_snapshot, term_classroom_id,
            source_membership_id, student_name_snapshot
        )
        SELECT student.roster_child_id, term_classroom.id, NULL, student.name
        FROM students AS student
        JOIN projects AS project ON project.id = student.project_id
        JOIN academic_term_classrooms AS term_classroom
          ON term_classroom.classroom_id = project.classroom_id
        WHERE term_classroom.semester_id = :term_id
          AND project.deleted_at IS NULL
          AND student.roster_child_id IS NOT NULL
          AND NOT EXISTS (
                SELECT 1
                FROM students AS candidate
                JOIN projects AS candidate_project
                  ON candidate_project.id = candidate.project_id
                JOIN academic_term_classrooms AS candidate_classroom
                  ON candidate_classroom.classroom_id =
                        candidate_project.classroom_id
                WHERE candidate_classroom.semester_id = :term_id
                  AND candidate_project.deleted_at IS NULL
                  AND candidate.roster_child_id = student.roster_child_id
                  AND (
                        COALESCE(candidate_project.created_at, '') >
                            COALESCE(project.created_at, '')
                     OR (
                            COALESCE(candidate_project.created_at, '') =
                                COALESCE(project.created_at, '')
                        AND candidate_project.id > project.id
                     )
                     OR (
                            COALESCE(candidate_project.created_at, '') =
                                COALESCE(project.created_at, '')
                        AND candidate_project.id = project.id
                        AND candidate.id > student.id
                     )
                  )
            )
    """), {"term_id": imported_term_id})

    # 目前 membership 一律覆蓋 Project fallback，因此轉班後只落目標班。
    connection.execute(text("""
        INSERT OR REPLACE INTO temp_imported_term_student_snapshot_desired (
            roster_child_id_snapshot, term_classroom_id,
            source_membership_id, student_name_snapshot
        )
        SELECT member.roster_child_id, term_classroom.id,
               member.id, child.name
        FROM classroom_members AS member
        JOIN roster_children AS child ON child.id = member.roster_child_id
        JOIN academic_term_classrooms AS term_classroom
          ON term_classroom.classroom_id = member.classroom_id
        WHERE term_classroom.semester_id = :term_id
          AND member.ended_at IS NULL
    """), {"term_id": imported_term_id})

    # 舊版曾只限制每班唯一；建立整學期 unique index 前先收旂。
    connection.execute(text("""
        DELETE FROM academic_term_classroom_students
        WHERE semester_id = :term_id
          AND id NOT IN (
                SELECT MIN(id)
                FROM academic_term_classroom_students
                WHERE semester_id = :term_id
                GROUP BY roster_child_id_snapshot
            )
    """), {"term_id": imported_term_id})

    connection.execute(text("""
        UPDATE academic_term_classroom_students
        SET term_classroom_id = (
                SELECT desired.term_classroom_id
                FROM temp_imported_term_student_snapshot_desired AS desired
                WHERE desired.roster_child_id_snapshot =
                    academic_term_classroom_students.roster_child_id_snapshot
            ),
            source_membership_id = (
                SELECT desired.source_membership_id
                FROM temp_imported_term_student_snapshot_desired AS desired
                WHERE desired.roster_child_id_snapshot =
                    academic_term_classroom_students.roster_child_id_snapshot
            ),
            student_name_snapshot = (
                SELECT desired.student_name_snapshot
                FROM temp_imported_term_student_snapshot_desired AS desired
                WHERE desired.roster_child_id_snapshot =
                    academic_term_classroom_students.roster_child_id_snapshot
            )
        WHERE semester_id = :term_id
          AND EXISTS (
                SELECT 1
                FROM temp_imported_term_student_snapshot_desired AS desired
                WHERE desired.roster_child_id_snapshot =
                    academic_term_classroom_students.roster_child_id_snapshot
                  AND desired.source_membership_id IS NOT NULL
            )
    """), {"term_id": imported_term_id})

    connection.execute(text("""
        INSERT INTO academic_term_classroom_students (
            semester_id, term_classroom_id, source_membership_id,
            roster_child_id_snapshot, student_name_snapshot
        )
        SELECT :term_id, desired.term_classroom_id,
               desired.source_membership_id,
               desired.roster_child_id_snapshot,
               desired.student_name_snapshot
        FROM temp_imported_term_student_snapshot_desired AS desired
        WHERE NOT EXISTS (
            SELECT 1
            FROM academic_term_classroom_students AS snapshot
            WHERE snapshot.semester_id = :term_id
              AND snapshot.roster_child_id_snapshot =
                    desired.roster_child_id_snapshot
        )
    """), {"term_id": imported_term_id})
    connection.execute(text(
        "DROP TABLE temp_imported_term_student_snapshot_desired"
    ))


def _add_semester_reporting_freeze_triggers(connection):
    """凍結已歸班 Project 快照、工作格 identity 與已開始時間。"""
    if _is_term_scoped_classroom_schema(connection):
        return
    for trigger_name in (
        "trg_semester_students_match_term_insert",
        "trg_semester_students_match_term_update",
        "trg_semester_students_freeze_insert",
        "trg_semester_students_freeze_update",
        "trg_semester_students_freeze_delete",
    ):
        connection.execute(text(f"DROP TRIGGER IF EXISTS {trigger_name}"))
    connection.execute(text("""
        CREATE TRIGGER trg_semester_students_match_term_insert
        BEFORE INSERT ON academic_term_classroom_students
        WHEN NEW.semester_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM academic_term_classrooms AS term_classroom
            WHERE term_classroom.id = NEW.term_classroom_id
              AND term_classroom.semester_id = NEW.semester_id
        )
        BEGIN
            SELECT RAISE(ABORT, 'student snapshot term must match classroom term');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER trg_semester_students_match_term_update
        BEFORE UPDATE OF semester_id, term_classroom_id
        ON academic_term_classroom_students
        WHEN NEW.semester_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM academic_term_classrooms AS term_classroom
            WHERE term_classroom.id = NEW.term_classroom_id
              AND term_classroom.semester_id = NEW.semester_id
        )
        BEGIN
            SELECT RAISE(ABORT, 'student snapshot term must match classroom term');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER trg_semester_students_freeze_insert
        BEFORE INSERT ON academic_term_classroom_students
        WHEN EXISTS (
            SELECT 1
            FROM academic_term_classrooms AS term_classroom
            JOIN semesters AS term
              ON term.id = term_classroom.semester_id
            WHERE term_classroom.id = NEW.term_classroom_id
              AND term.status = 'closed'
        )
        BEGIN
            SELECT RAISE(ABORT, 'formal term student snapshots are immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER trg_semester_students_freeze_update
        BEFORE UPDATE ON academic_term_classroom_students
        WHEN EXISTS (
            SELECT 1
            FROM academic_term_classrooms AS term_classroom
            JOIN semesters AS term
              ON term.id = term_classroom.semester_id
            WHERE term_classroom.id = OLD.term_classroom_id
              AND term.status = 'closed'
        )
        BEGIN
            SELECT RAISE(ABORT, 'formal term student snapshots are immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER trg_semester_students_freeze_delete
        BEFORE DELETE ON academic_term_classroom_students
        WHEN EXISTS (
            SELECT 1
            FROM academic_term_classrooms AS term_classroom
            JOIN semesters AS term
              ON term.id = term_classroom.semester_id
            WHERE term_classroom.id = OLD.term_classroom_id
              AND term.status = 'closed'
        )
        BEGIN
            SELECT RAISE(ABORT, 'formal term student snapshots are immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER IF NOT EXISTS trg_projects_freeze_classroom_snapshots
        BEFORE UPDATE OF campus_id_snapshot, campus_name_snapshot,
                         classroom_name_snapshot, department ON projects
        WHEN OLD.classroom_id IS NOT NULL AND (
            NEW.campus_id_snapshot IS NOT OLD.campus_id_snapshot
            OR NEW.campus_name_snapshot IS NOT OLD.campus_name_snapshot
            OR NEW.classroom_name_snapshot IS NOT OLD.classroom_name_snapshot
            OR NEW.department IS NOT OLD.department
        )
        BEGIN
            SELECT RAISE(ABORT, 'class-backed project snapshots are immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER IF NOT EXISTS trg_projects_freeze_assigned_classroom
        BEFORE UPDATE OF classroom_id ON projects
        WHEN OLD.classroom_id IS NOT NULL
         AND NEW.classroom_id IS NOT NULL
         AND NEW.classroom_id IS NOT OLD.classroom_id
        BEGIN
            SELECT RAISE(ABORT, 'class-backed project classroom is immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER IF NOT EXISTS trg_projects_freeze_work_slot
        BEFORE UPDATE OF class_period_work_slot_id ON projects
        WHEN OLD.class_period_work_slot_id IS NOT NULL
         AND NEW.class_period_work_slot_id IS NOT OLD.class_period_work_slot_id
         AND NEW.classroom_id IS NOT NULL
        BEGIN
            SELECT RAISE(ABORT, 'project work slot is immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER IF NOT EXISTS trg_work_slots_freeze_identity
        BEFORE UPDATE OF term_classroom_id, semester_period_id
        ON class_period_work_slots
        WHEN NEW.term_classroom_id IS NOT OLD.term_classroom_id
          OR NEW.semester_period_id IS NOT OLD.semester_period_id
        BEGIN
            SELECT RAISE(ABORT, 'work slot identity is immutable');
        END
    """))
    connection.execute(text("""
        CREATE TRIGGER IF NOT EXISTS trg_work_slots_freeze_started_at
        BEFORE UPDATE OF started_at ON class_period_work_slots
        WHEN OLD.started_at IS NOT NULL
         AND NEW.started_at IS NOT OLD.started_at
        BEGIN
            SELECT RAISE(ABORT, 'started work slot cannot be reset');
        END
    """))


def _add_organization_structure(connection):
    """加入分校、班級目前名單與可追溯的專案負責人轉交資料。"""
    if _is_term_scoped_classroom_schema(connection):
        return
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS campuses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name VARCHAR NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS classrooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campus_id INTEGER NOT NULL REFERENCES campuses(id),
            department VARCHAR NOT NULL,
            name VARCHAR NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS classroom_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            classroom_id INTEGER NOT NULL REFERENCES classrooms(id),
            roster_child_id INTEGER NOT NULL REFERENCES roster_children(id),
            started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME,
            end_reason TEXT
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS project_assignment_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            from_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            from_owner_name VARCHAR,
            to_owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            to_owner_name VARCHAR NOT NULL,
            changed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            changed_by_name VARCHAR,
            reason TEXT,
            changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """))

    project_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "classroom_id" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN classroom_id INTEGER "
            "REFERENCES classrooms(id) ON DELETE SET NULL"
        ))
    if "created_by_id" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN created_by_id INTEGER "
            "REFERENCES users(id) ON DELETE SET NULL"
        ))
    if "created_by_name" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN created_by_name VARCHAR"
        ))

    classroom_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(classrooms)"))
    }
    if "department" not in classroom_columns:
        # 修復開發期間曾啟動過的中間 schema；正式 API 尚未存在，因此沒有班級資料。
        connection.execute(text(
            "ALTER TABLE classrooms ADD COLUMN department VARCHAR "
            "NOT NULL DEFAULT 'infant'"
        ))
    member_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(classroom_members)"))
    }
    if "end_reason" not in member_columns:
        connection.execute(text(
            "ALTER TABLE classroom_members ADD COLUMN end_reason TEXT"
        ))

    # 中間版本的索引只限制同班重複，仍可能同時在兩班；只在舊定義存在時重建。
    # 索引名不隨 ALTER TABLE RENAME 改變，所以舊名與新名都要檢查。
    for index_name in (
        "ux_class_roster_active_child",
        "ux_classroom_members_active_child",
    ):
        active_member_index_sql = connection.execute(
            text(
                "SELECT sql FROM sqlite_master "
                "WHERE type = 'index' AND name = :index_name"
            ),
            {"index_name": index_name},
        ).scalar()
        if active_member_index_sql and "classroom_id" in active_member_index_sql.lower():
            connection.execute(text(f"DROP INDEX {index_name}"))

    index_statements = (
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_campuses_name ON campuses(name)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_classrooms_scope_name "
        "ON classrooms(campus_id, department, name)",
        "CREATE INDEX IF NOT EXISTS idx_classrooms_campus_id ON classrooms(campus_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_members_classroom_id "
        "ON classroom_members(classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_members_roster_child_id "
        "ON classroom_members(roster_child_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_classroom_members_active_child "
        "ON classroom_members(roster_child_id) "
        "WHERE ended_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_projects_classroom_id ON projects(classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_projects_created_by_id ON projects(created_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_assignment_history_project_id "
        "ON project_assignment_history(project_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_assignment_history_from_owner_id "
        "ON project_assignment_history(from_owner_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_assignment_history_to_owner_id "
        "ON project_assignment_history(to_owner_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_assignment_history_changed_by_id "
        "ON project_assignment_history(changed_by_id)",
    )
    for statement in index_statements:
        connection.execute(text(statement))
    connection.commit()


def _add_organization_access_and_reclassification_schema(connection):
    """加入班級老師、專案協作者、名稱快照與新學期編班草稿 schema。"""
    if _is_term_scoped_classroom_schema(connection):
        return
    project_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "campus_name_snapshot" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN campus_name_snapshot VARCHAR"
        ))
    if "classroom_name_snapshot" not in project_columns:
        connection.execute(text(
            "ALTER TABLE projects ADD COLUMN classroom_name_snapshot VARCHAR"
        ))

    # 已有明確 classroom_id 的資料可無歧義遷移名稱快照；只補 NULL，避免日後班級改名
    # 時重跑 migration 改寫相本建立當下的顯示名稱。
    if "classroom_id" in project_columns:
        connection.execute(text("""
            UPDATE projects
            SET campus_name_snapshot = COALESCE(campus_name_snapshot, (
                    SELECT campuses.name
                    FROM classrooms
                    JOIN campuses ON campuses.id = classrooms.campus_id
                    WHERE classrooms.id = projects.classroom_id
                )),
                classroom_name_snapshot = COALESCE(classroom_name_snapshot, (
                    SELECT classrooms.name
                    FROM classrooms
                    WHERE classrooms.id = projects.classroom_id
                ))
            WHERE classroom_id IS NOT NULL
              AND (campus_name_snapshot IS NULL OR classroom_name_snapshot IS NULL)
        """))

    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS classroom_teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            classroom_id INTEGER NOT NULL REFERENCES classrooms(id),
            teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            teacher_name_snapshot VARCHAR NOT NULL,
            duty VARCHAR NOT NULL
                CONSTRAINT ck_classroom_teachers_duty
                CHECK (duty IN ('lead', 'co_teacher')),
            started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME,
            end_reason TEXT,
            started_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            started_by_name_snapshot VARCHAR NOT NULL,
            ended_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            ended_by_name_snapshot VARCHAR
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS project_editor_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            user_name_snapshot VARCHAR NOT NULL,
            started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME,
            end_reason TEXT,
            started_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            started_by_name_snapshot VARCHAR NOT NULL,
            ended_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            ended_by_name_snapshot VARCHAR
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS term_reclassification_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_key VARCHAR NOT NULL DEFAULT 'organization'
                CONSTRAINT ck_term_reclassification_plans_scope
                CHECK (scope_key = 'organization'),
            label VARCHAR NOT NULL,
            status VARCHAR NOT NULL DEFAULT 'draft'
                CONSTRAINT ck_term_reclassification_plans_status
                CHECK (status IN ('draft', 'applied', 'cancelled')),
            revision INTEGER NOT NULL DEFAULT 1
                CONSTRAINT ck_term_reclassification_plans_revision
                CHECK (revision >= 1),
            source_fingerprint VARCHAR NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            applied_at DATETIME,
            cancelled_at DATETIME,
            created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_by_name_snapshot VARCHAR NOT NULL,
            updated_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_by_name_snapshot VARCHAR,
            applied_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            applied_by_name_snapshot VARCHAR,
            cancelled_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            cancelled_by_name_snapshot VARCHAR
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS term_student_placements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL
                REFERENCES term_reclassification_plans(id) ON DELETE CASCADE,
            source_membership_id INTEGER NOT NULL REFERENCES classroom_members(id),
            roster_child_id_snapshot INTEGER NOT NULL,
            student_name_snapshot VARCHAR NOT NULL,
            source_campus_id_snapshot INTEGER NOT NULL,
            source_campus_name_snapshot VARCHAR NOT NULL,
            source_classroom_id_snapshot INTEGER NOT NULL,
            source_classroom_name_snapshot VARCHAR NOT NULL,
            outcome VARCHAR NOT NULL
                CONSTRAINT ck_term_student_placements_outcome
                CHECK (outcome IN ('classroom', 'departed')),
            target_classroom_id INTEGER REFERENCES classrooms(id),
            CONSTRAINT ck_term_student_placements_target CHECK (
                (outcome = 'classroom' AND target_classroom_id IS NOT NULL)
                OR (outcome = 'departed' AND target_classroom_id IS NULL)
            ),
            CONSTRAINT ux_term_student_placements_plan_member
                UNIQUE (plan_id, source_membership_id)
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS term_classroom_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_id INTEGER NOT NULL
                REFERENCES term_reclassification_plans(id) ON DELETE CASCADE,
            classroom_id INTEGER NOT NULL REFERENCES classrooms(id),
            CONSTRAINT ux_term_classroom_plans_plan_classroom
                UNIQUE (plan_id, classroom_id)
        )
    """))
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS term_classroom_teacher_targets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            classroom_plan_id INTEGER NOT NULL
                REFERENCES term_classroom_plans(id) ON DELETE CASCADE,
            teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            teacher_name_snapshot VARCHAR NOT NULL,
            duty VARCHAR NOT NULL
                CONSTRAINT ck_term_classroom_teacher_targets_duty
                CHECK (duty IN ('lead', 'co_teacher')),
            CONSTRAINT ux_term_classroom_teacher_targets_plan_teacher
                UNIQUE (classroom_plan_id, teacher_id)
        )
    """))

    index_statements = (
        "CREATE INDEX IF NOT EXISTS idx_classroom_teachers_classroom_id "
        "ON classroom_teachers(classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_teachers_teacher_id "
        "ON classroom_teachers(teacher_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_teachers_started_by_id "
        "ON classroom_teachers(started_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_classroom_teachers_ended_by_id "
        "ON classroom_teachers(ended_by_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_classroom_teacher_active "
        "ON classroom_teachers(classroom_id, teacher_id) "
        "WHERE ended_at IS NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_classroom_teacher_active_lead "
        "ON classroom_teachers(classroom_id) "
        "WHERE ended_at IS NULL AND duty = 'lead'",
        "CREATE INDEX IF NOT EXISTS idx_project_editor_assignments_project_id "
        "ON project_editor_assignments(project_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_editor_assignments_user_id "
        "ON project_editor_assignments(user_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_editor_assignments_started_by_id "
        "ON project_editor_assignments(started_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_project_editor_assignments_ended_by_id "
        "ON project_editor_assignments(ended_by_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_project_editor_active "
        "ON project_editor_assignments(project_id, user_id) "
        "WHERE ended_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_term_reclassification_plans_created_by_id "
        "ON term_reclassification_plans(created_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_reclassification_plans_updated_by_id "
        "ON term_reclassification_plans(updated_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_reclassification_plans_applied_by_id "
        "ON term_reclassification_plans(applied_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_reclassification_plans_cancelled_by_id "
        "ON term_reclassification_plans(cancelled_by_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_term_reclassification_draft_scope "
        "ON term_reclassification_plans(scope_key) WHERE status = 'draft'",
        "CREATE INDEX IF NOT EXISTS idx_term_student_placements_plan_id "
        "ON term_student_placements(plan_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_student_placements_source_membership_id "
        "ON term_student_placements(source_membership_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_student_placements_target_classroom_id "
        "ON term_student_placements(target_classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_classroom_plans_plan_id "
        "ON term_classroom_plans(plan_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_classroom_plans_classroom_id "
        "ON term_classroom_plans(classroom_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_classroom_teacher_targets_plan_id "
        "ON term_classroom_teacher_targets(classroom_plan_id)",
        "CREATE INDEX IF NOT EXISTS idx_term_classroom_teacher_targets_teacher_id "
        "ON term_classroom_teacher_targets(teacher_id)",
    )
    for statement in index_statements:
        connection.execute(text(statement))
    connection.commit()


def _allow_multiple_term_target_leads(connection):
    """草稿可暫存多位主教，正式 apply 前再由 business validation 阻擋。"""
    connection.execute(text(
        "DROP INDEX IF EXISTS ux_term_classroom_teacher_target_lead"
    ))
    connection.commit()


def _add_organization_supervisor_assignments(connection):
    """加入分校／部門主管的可稽核授權區間，不推測既有主管 scope。"""
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS organization_supervisor_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campus_id INTEGER NOT NULL REFERENCES campuses(id),
            department VARCHAR
                CONSTRAINT ck_organization_supervisor_assignments_department
                CHECK (department IS NULL OR department IN ('infant', 'academy')),
            supervisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            supervisor_name_snapshot VARCHAR NOT NULL,
            started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            ended_at DATETIME,
            end_reason TEXT,
            started_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            started_by_name_snapshot VARCHAR NOT NULL,
            ended_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            ended_by_name_snapshot VARCHAR
        )
    """))
    index_statements = (
        "CREATE INDEX IF NOT EXISTS idx_organization_supervisors_campus_id "
        "ON organization_supervisor_assignments(campus_id)",
        "CREATE INDEX IF NOT EXISTS idx_organization_supervisors_supervisor_id "
        "ON organization_supervisor_assignments(supervisor_id)",
        "CREATE INDEX IF NOT EXISTS idx_organization_supervisors_started_by_id "
        "ON organization_supervisor_assignments(started_by_id)",
        "CREATE INDEX IF NOT EXISTS idx_organization_supervisors_ended_by_id "
        "ON organization_supervisor_assignments(ended_by_id)",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_organization_supervisor_active_campus "
        "ON organization_supervisor_assignments(campus_id, supervisor_id) "
        "WHERE ended_at IS NULL AND department IS NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_organization_supervisor_active_department "
        "ON organization_supervisor_assignments(campus_id, department, supervisor_id) "
        "WHERE ended_at IS NULL AND department IS NOT NULL",
    )
    for statement in index_statements:
        connection.execute(text(statement))
    connection.commit()


def _quarantine_class_backed_identity_anomalies(connection):
    """隔離無法安全視為班級快照的舊相本，不猜測或改寫 Student 身分。"""
    connection.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {LEGACY_PROJECT_IDENTITY_QUARANTINE_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id_snapshot INTEGER NOT NULL UNIQUE,
            project_name_snapshot VARCHAR NOT NULL,
            project_department_snapshot VARCHAR,
            project_deleted_at_snapshot DATETIME,
            original_classroom_id_snapshot INTEGER NOT NULL,
            original_classroom_department_snapshot VARCHAR,
            original_classroom_name_snapshot VARCHAR,
            original_campus_id_snapshot INTEGER,
            original_campus_name_snapshot VARCHAR,
            project_campus_name_snapshot VARCHAR,
            project_classroom_name_snapshot VARCHAR,
            student_count INTEGER NOT NULL
                CONSTRAINT ck_legacy_identity_quarantine_student_count
                CHECK (student_count >= 1),
            anomalous_student_count INTEGER NOT NULL
                CONSTRAINT ck_legacy_identity_quarantine_anomaly_count
                CHECK (anomalous_student_count >= 1),
            null_roster_child_count INTEGER NOT NULL
                CONSTRAINT ck_legacy_identity_quarantine_null_count
                CHECK (null_roster_child_count >= 0),
            invalid_roster_child_count INTEGER NOT NULL
                CONSTRAINT ck_legacy_identity_quarantine_invalid_count
                CHECK (invalid_roster_child_count >= 0),
            duplicate_roster_child_student_count INTEGER NOT NULL
                CONSTRAINT ck_legacy_identity_quarantine_duplicate_count
                CHECK (duplicate_roster_child_student_count >= 0),
            quarantined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """))
    connection.execute(text(f"""
        CREATE TRIGGER IF NOT EXISTS trg_legacy_identity_quarantines_no_update
        BEFORE UPDATE ON {LEGACY_PROJECT_IDENTITY_QUARANTINE_TABLE}
        BEGIN
            SELECT RAISE(ABORT, 'legacy identity quarantine ledger is append-only');
        END
    """))
    connection.execute(text(f"""
        CREATE TRIGGER IF NOT EXISTS trg_legacy_identity_quarantines_no_delete
        BEFORE DELETE ON {LEGACY_PROJECT_IDENTITY_QUARANTINE_TABLE}
        BEGIN
            SELECT RAISE(ABORT, 'legacy identity quarantine ledger is append-only');
        END
    """))

    project_columns = {
        row[1] for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    project_quarantine_updates = "classroom_id = NULL"
    if "class_period_work_slot_id" in project_columns:
        project_quarantine_updates += ", class_period_work_slot_id = NULL"

    anomalous_projects = list(connection.execute(text("""
        WITH duplicate_students AS (
            SELECT student.id
            FROM students AS student
            JOIN (
                SELECT project_id, roster_child_id
                FROM students
                WHERE roster_child_id IS NOT NULL
                GROUP BY project_id, roster_child_id
                HAVING COUNT(*) > 1
            ) AS duplicate_link
              ON duplicate_link.project_id = student.project_id
             AND duplicate_link.roster_child_id = student.roster_child_id
        ),
        student_counts AS (
            SELECT
                student.project_id,
                COUNT(*) AS student_count,
                SUM(CASE
                    WHEN student.roster_child_id IS NULL THEN 1 ELSE 0
                END) AS null_roster_child_count,
                SUM(CASE
                    WHEN student.roster_child_id IS NOT NULL
                     AND roster_child.id IS NULL THEN 1 ELSE 0
                END) AS invalid_roster_child_count,
                SUM(CASE
                    WHEN duplicate_student.id IS NOT NULL THEN 1 ELSE 0
                END) AS duplicate_roster_child_student_count,
                SUM(CASE
                    WHEN student.roster_child_id IS NULL
                      OR roster_child.id IS NULL
                      OR duplicate_student.id IS NOT NULL
                    THEN 1 ELSE 0
                END) AS anomalous_student_count
            FROM students AS student
            LEFT JOIN roster_children AS roster_child
              ON roster_child.id = student.roster_child_id
            LEFT JOIN duplicate_students AS duplicate_student
              ON duplicate_student.id = student.id
            GROUP BY student.project_id
        )
        SELECT
            project.id AS project_id_snapshot,
            project.name AS project_name_snapshot,
            project.department AS project_department_snapshot,
            project.deleted_at AS project_deleted_at_snapshot,
            project.classroom_id AS original_classroom_id_snapshot,
            classroom.department AS original_classroom_department_snapshot,
            classroom.name AS original_classroom_name_snapshot,
            campus.id AS original_campus_id_snapshot,
            campus.name AS original_campus_name_snapshot,
            project.campus_name_snapshot AS project_campus_name_snapshot,
            project.classroom_name_snapshot AS project_classroom_name_snapshot,
            student_counts.student_count,
            student_counts.anomalous_student_count,
            student_counts.null_roster_child_count,
            student_counts.invalid_roster_child_count,
            student_counts.duplicate_roster_child_student_count
        FROM projects AS project
        JOIN student_counts ON student_counts.project_id = project.id
        LEFT JOIN classrooms AS classroom ON classroom.id = project.classroom_id
        LEFT JOIN campuses AS campus ON campus.id = classroom.campus_id
        WHERE project.classroom_id IS NOT NULL
          AND student_counts.anomalous_student_count > 0
        ORDER BY project.id
    """)).mappings())

    for project_snapshot in anomalous_projects:
        connection.execute(text(f"""
            INSERT OR IGNORE INTO {LEGACY_PROJECT_IDENTITY_QUARANTINE_TABLE} (
                project_id_snapshot,
                project_name_snapshot,
                project_department_snapshot,
                project_deleted_at_snapshot,
                original_classroom_id_snapshot,
                original_classroom_department_snapshot,
                original_classroom_name_snapshot,
                original_campus_id_snapshot,
                original_campus_name_snapshot,
                project_campus_name_snapshot,
                project_classroom_name_snapshot,
                student_count,
                anomalous_student_count,
                null_roster_child_count,
                invalid_roster_child_count,
                duplicate_roster_child_student_count
            ) VALUES (
                :project_id_snapshot,
                :project_name_snapshot,
                :project_department_snapshot,
                :project_deleted_at_snapshot,
                :original_classroom_id_snapshot,
                :original_classroom_department_snapshot,
                :original_classroom_name_snapshot,
                :original_campus_id_snapshot,
                :original_campus_name_snapshot,
                :project_campus_name_snapshot,
                :project_classroom_name_snapshot,
                :student_count,
                :anomalous_student_count,
                :null_roster_child_count,
                :invalid_roster_child_count,
                :duplicate_roster_child_student_count
            )
        """), dict(project_snapshot))
        connection.execute(text(f"""
            UPDATE projects
            SET {project_quarantine_updates}
            WHERE id = :project_id_snapshot
              AND classroom_id = :original_classroom_id_snapshot
        """), dict(project_snapshot))
    connection.commit()


def _add_legacy_project_identity_migration_schema(connection):
    """加入舊相本歸班的不可變稽核帳本與資料庫 identity freeze 防線。"""
    connection.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id_snapshot INTEGER NOT NULL UNIQUE,
            project_name_snapshot VARCHAR NOT NULL,
            project_department_snapshot VARCHAR,
            target_campus_id_snapshot INTEGER NOT NULL,
            target_campus_name_snapshot VARCHAR NOT NULL,
            target_classroom_id_snapshot INTEGER NOT NULL,
            target_classroom_name_snapshot VARCHAR NOT NULL,
            target_department_snapshot VARCHAR NOT NULL,
            source_fingerprint VARCHAR NOT NULL,
            student_count INTEGER NOT NULL
                CONSTRAINT ck_legacy_project_migration_student_count
                CHECK (student_count >= 0),
            seeded_member_count INTEGER NOT NULL
                CONSTRAINT ck_legacy_project_migration_seeded_count
                CHECK (seeded_member_count >= 0),
            applied_by_id_snapshot INTEGER NOT NULL,
            applied_by_name_snapshot VARCHAR NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """))
    connection.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            migration_id INTEGER NOT NULL
                REFERENCES {LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE}(id)
                ON DELETE RESTRICT,
            project_id_snapshot INTEGER NOT NULL,
            student_id_snapshot INTEGER NOT NULL UNIQUE,
            student_name_snapshot VARCHAR NOT NULL,
            student_order_index_snapshot INTEGER NOT NULL,
            student_created_at_snapshot DATETIME,
            original_roster_child_id_snapshot INTEGER,
            original_roster_child_name_snapshot VARCHAR,
            resolution_action VARCHAR NOT NULL
                CONSTRAINT ck_legacy_student_resolution_action
                CHECK (resolution_action IN ('existing', 'create_new')),
            resolved_roster_child_id_snapshot INTEGER NOT NULL,
            resolved_roster_child_name_snapshot VARCHAR NOT NULL,
            seeded_current_roster BOOLEAN NOT NULL,
            class_roster_member_id_snapshot INTEGER,
            source_fingerprint VARCHAR NOT NULL,
            applied_by_id_snapshot INTEGER NOT NULL,
            applied_by_name_snapshot VARCHAR NOT NULL,
            resolved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT ux_legacy_student_resolution_migration_student
                UNIQUE (migration_id, student_id_snapshot),
            CONSTRAINT ck_legacy_student_resolution_seed_member CHECK (
                (seeded_current_roster = 1
                    AND class_roster_member_id_snapshot IS NOT NULL)
                OR (seeded_current_roster = 0
                    AND class_roster_member_id_snapshot IS NULL)
            )
        )
    """))
    index_statements = (
        f"CREATE INDEX IF NOT EXISTS idx_legacy_project_migrations_target_classroom "
        f"ON {LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE}"
        "(target_classroom_id_snapshot)",
        f"CREATE INDEX IF NOT EXISTS idx_legacy_student_resolutions_migration "
        f"ON {LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE}(migration_id)",
        f"CREATE INDEX IF NOT EXISTS idx_legacy_student_resolutions_resolved_child "
        f"ON {LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE}"
        "(resolved_roster_child_id_snapshot)",
    )
    for statement in index_statements:
        connection.execute(text(statement))

    # ledger 是 append-only；不讓 operational row 的生命週期改寫或刪除歷史證據。
    append_only_triggers = (
        (
            "trg_legacy_project_migrations_no_update",
            LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE,
            "UPDATE",
        ),
        (
            "trg_legacy_project_migrations_no_delete",
            LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE,
            "DELETE",
        ),
        (
            "trg_legacy_student_resolutions_no_update",
            LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE,
            "UPDATE",
        ),
        (
            "trg_legacy_student_resolutions_no_delete",
            LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE,
            "DELETE",
        ),
    )
    for trigger_name, table_name, operation in append_only_triggers:
        connection.execute(text(f"""
            CREATE TRIGGER IF NOT EXISTS {trigger_name}
            BEFORE {operation} ON {table_name}
            BEGIN
                SELECT RAISE(ABORT, 'legacy identity migration ledger is append-only');
            END
        """))

    connection.execute(text(f"""
        CREATE TRIGGER IF NOT EXISTS trg_students_freeze_class_backed_identity
        BEFORE UPDATE OF name, roster_child_id, project_id ON students
        WHEN (
            NEW.name IS NOT OLD.name
            OR NEW.roster_child_id IS NOT OLD.roster_child_id
            OR NEW.project_id IS NOT OLD.project_id
        ) AND (
            EXISTS (
                SELECT 1 FROM projects
                WHERE projects.id = OLD.project_id
                  AND projects.classroom_id IS NOT NULL
            )
            OR EXISTS (
                SELECT 1 FROM projects
                WHERE projects.id = NEW.project_id
                  AND projects.classroom_id IS NOT NULL
            )
        )
        BEGIN
            SELECT RAISE(ABORT, 'class-backed student identity is immutable');
        END
    """))
    connection.execute(text(f"""
        CREATE TRIGGER IF NOT EXISTS trg_projects_reject_empty_identity_migration
        BEFORE UPDATE OF classroom_id ON projects
        WHEN OLD.classroom_id IS NULL
          AND NEW.classroom_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM students
              WHERE students.project_id = OLD.id
          )
        BEGIN
            SELECT RAISE(
                ABORT,
                'empty project cannot enter class-backed identity migration'
            );
        END
    """))
    connection.execute(text(f"""
        CREATE TRIGGER IF NOT EXISTS trg_projects_require_identity_migration_ledger
        BEFORE UPDATE OF classroom_id ON projects
        WHEN OLD.classroom_id IS NULL AND NEW.classroom_id IS NOT NULL
        BEGIN
            SELECT CASE WHEN NOT EXISTS (
                SELECT 1
                FROM {LEGACY_PROJECT_CLASSROOM_MIGRATION_TABLE} AS migration
                WHERE migration.project_id_snapshot = OLD.id
                  AND migration.target_classroom_id_snapshot = NEW.classroom_id
                  AND migration.student_count = (
                      SELECT COUNT(*) FROM students
                      WHERE students.project_id = OLD.id
                  )
                  AND migration.student_count = (
                      SELECT COUNT(*)
                      FROM {LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE} AS resolution
                      WHERE resolution.migration_id = migration.id
                        AND resolution.project_id_snapshot = OLD.id
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM students AS student
                      WHERE student.project_id = OLD.id
                        AND NOT EXISTS (
                            SELECT 1
                            FROM {LEGACY_STUDENT_IDENTITY_RESOLUTION_TABLE}
                                AS resolution
                            WHERE resolution.migration_id = migration.id
                              AND resolution.student_id_snapshot = student.id
                              AND resolution.student_name_snapshot = student.name
                              AND resolution.resolved_roster_child_id_snapshot
                                  = student.roster_child_id
                        )
                  )
            ) THEN RAISE(
                ABORT,
                'project classroom transition requires complete identity migration ledger'
            ) END;
        END
    """))
    connection.commit()


def _retire_active_project_editor_assignments(connection):
    """舊協作者 grant 只留歷史；班級目前老師改由園所設定直接授權。"""
    connection.execute(text("""
        UPDATE project_editor_assignments
        SET ended_at = CURRENT_TIMESTAMP,
            end_reason = 'classroom_scope_migration',
            ended_by_id = NULL,
            ended_by_name_snapshot = '系統遷移'
        WHERE ended_at IS NULL
    """))
    connection.commit()


def _add_student_album_name_column(connection):
    """為學生加入可選相本稱呼；既有資料以 NULL 沿用名冊姓名。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(students)"))
    }
    if "album_name" not in existing_columns:
        connection.execute(text("ALTER TABLE students ADD COLUMN album_name VARCHAR"))
        connection.commit()


def _add_roster_child_album_name_column(connection):
    """為園所孩子名冊加入已歸班相本共用的可選稱呼。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(roster_children)"))
    }
    if "album_name" not in existing_columns:
        connection.execute(text(
            "ALTER TABLE roster_children ADD COLUMN album_name VARCHAR"
        ))
        connection.commit()


def _migrate_assigned_album_names_to_roster_authority(connection):
    """把可信的已歸班舊稱呼升格為名冊唯一來源，未歸班資料完全不碰。"""
    migration_key = "202607_roster_child_album_name_authority_v1"
    connection.execute(text("""
        CREATE TABLE IF NOT EXISTS schema_migration_markers (
            migration_key VARCHAR PRIMARY KEY,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """))
    if connection.execute(
        text("""
            SELECT 1
            FROM schema_migration_markers
            WHERE migration_key = :migration_key
        """),
        {"migration_key": migration_key},
    ).first() is not None:
        connection.commit()
        return

    overlong_child_ids = [
        int(row[0])
        for row in connection.execute(text("""
            SELECT DISTINCT student.roster_child_id
            FROM students AS student
            JOIN projects AS project ON project.id = student.project_id
            JOIN roster_children AS child ON child.id = student.roster_child_id
            WHERE project.classroom_id IS NOT NULL
              AND child.album_name IS NULL
              AND LENGTH(TRIM(student.album_name)) > 100
            ORDER BY student.roster_child_id
        """))
    ]
    if overlong_child_ids:
        raise RuntimeError(
            "已歸班舊相本稱呼超過 100 字，需先人工處理 roster_child_ids="
            + ",".join(str(child_id) for child_id in overlong_child_ids)
        )

    conflicting_child_ids = [
        int(row[0])
        for row in connection.execute(text("""
            SELECT student.roster_child_id
            FROM students AS student
            JOIN projects AS project ON project.id = student.project_id
            JOIN roster_children AS child ON child.id = student.roster_child_id
            WHERE project.classroom_id IS NOT NULL
              AND child.album_name IS NULL
              AND NULLIF(TRIM(student.album_name), '') IS NOT NULL
            GROUP BY student.roster_child_id
            HAVING COUNT(DISTINCT TRIM(student.album_name)) > 1
            ORDER BY student.roster_child_id
        """))
    ]
    if conflicting_child_ids:
        raise RuntimeError(
            "同一名冊學生在既有已歸班相本有不同稱呼，需先人工處理 "
            "roster_child_ids="
            + ",".join(str(child_id) for child_id in conflicting_child_ids)
        )

    # 只有同一孩子所有明確舊值一致時才自動升格；provisional link 不參與。
    connection.execute(text("""
        UPDATE roster_children
        SET album_name = (
            SELECT MIN(TRIM(student.album_name))
            FROM students AS student
            JOIN projects AS project ON project.id = student.project_id
            WHERE student.roster_child_id = roster_children.id
              AND project.classroom_id IS NOT NULL
              AND NULLIF(TRIM(student.album_name), '') IS NOT NULL
        )
        WHERE album_name IS NULL
          AND EXISTS (
            SELECT 1
            FROM students AS student
            JOIN projects AS project ON project.id = student.project_id
            WHERE student.roster_child_id = roster_children.id
              AND project.classroom_id IS NOT NULL
              AND NULLIF(TRIM(student.album_name), '') IS NOT NULL
          )
    """))

    # 以舊／新 runtime 真正會送進渲染器的字串比較；包含既有中央值、缺 child link
    # 及帶空白的歷史 raw 值，不能只檢查本次 backfill 的孩子。
    changed_student_filter = """
        FROM students AS student
        JOIN projects AS project ON project.id = student.project_id
        LEFT JOIN roster_children AS child ON child.id = student.roster_child_id
        WHERE project.classroom_id IS NOT NULL
          AND CASE
                  WHEN student.album_name IS NOT NULL
                  THEN student.album_name
                  ELSE student.name
              END
              != CASE
                     WHEN child.album_name IS NOT NULL
                     THEN child.album_name
                     ELSE student.name
                 END
    """
    connection.execute(text(f"""
        UPDATE projects
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id IN (SELECT project.id {changed_student_filter})
    """))
    connection.execute(text(f"""
        UPDATE students
        SET output_filename = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id IN (SELECT student.id {changed_student_filter})
    """))

    # Student.album_name 從此只保留給未歸班舊相本，避免形成第二份真相。
    connection.execute(text("""
        UPDATE students
        SET album_name = NULL
        WHERE id IN (
            SELECT student.id
            FROM students AS student
            JOIN projects AS project ON project.id = student.project_id
            WHERE project.classroom_id IS NOT NULL
              AND student.album_name IS NOT NULL
        )
    """))
    connection.execute(
        text("""
            INSERT INTO schema_migration_markers (migration_key)
            VALUES (:migration_key)
        """),
        {"migration_key": migration_key},
    )
    connection.commit()


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


def _add_student_completed_at_column(connection):
    """新增學生「個別完成」時間戳；既有已全班完成的專案不回填學生時間戳。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(students)"))
    }
    if "completed_at" not in existing_columns:
        connection.execute(text("ALTER TABLE students ADD COLUMN completed_at DATETIME"))
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
    # label_texts_json 是此歷史遷移的終態；不可在後續啟動重新建立舊欄位，
    # 否則後面的 drop-table 遷移會用舊 schema 重建 projects 並遺失新欄位。
    if "label_texts_json" in existing_columns:
        return
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
    if LEGACY_TEACHER_SUPERVISOR_ARCHIVE_TABLE in existing_tables:
        return
    user_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(users)"))
    }
    if "supervisor_id" not in user_columns and "teacher_supervisors" not in existing_tables:
        return
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
    existing_tables = {
        row[0]
        for row in connection.execute(text(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ))
    }
    indexes_to_create = [
        ("idx_projects_owner_id",         "CREATE INDEX idx_projects_owner_id ON projects(owner_id)"),
        ("idx_students_project_id",        "CREATE INDEX idx_students_project_id ON students(project_id)"),
        ("idx_project_comments_project_id","CREATE INDEX idx_project_comments_project_id ON project_comments(project_id)"),
        ("idx_project_comments_author_id", "CREATE INDEX idx_project_comments_author_id ON project_comments(author_id)"),
        ("idx_template_pages_template_id", "CREATE INDEX idx_template_pages_template_id ON template_pages(template_id)"),
    ]
    if (
        LEGACY_TEACHER_SUPERVISOR_ARCHIVE_TABLE not in existing_tables
        and "teacher_supervisors" in existing_tables
    ):
        indexes_to_create.append((
            "idx_teacher_supervisors_supervisor_id",
            "CREATE INDEX idx_teacher_supervisors_supervisor_id "
            "ON teacher_supervisors(supervisor_id)",
        ))
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

    新版 SQLite 直接 DROP COLUMN；舊版則依原始 CREATE TABLE 動態重建，
    不可硬編碼舊 schema，否則 interrupted migration 會遺失後來新增的欄位／索引／外鍵。
    冪等：若欄位已不存在則跳過。
    """
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
    }
    if "bubble_texts_json" not in existing_columns:
        return

    try:
        connection.execute(text("ALTER TABLE projects DROP COLUMN bubble_texts_json"))
        connection.commit()
        return
    except OperationalError:
        connection.rollback()

    table_sql = connection.execute(text(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'"
    )).scalar_one()
    schema_objects = list(connection.execute(text("""
        SELECT type, name, sql
        FROM sqlite_master
        WHERE tbl_name = 'projects'
          AND type IN ('index', 'trigger')
          AND sql IS NOT NULL
        ORDER BY type, name
    """)))
    external_project_trigger_sql = connection.execute(text("""
        SELECT sql
        FROM sqlite_master
        WHERE type = 'trigger'
          AND name = 'trg_students_freeze_class_backed_identity'
          AND sql IS NOT NULL
    """)).scalar_one_or_none()
    kept_columns = [
        row[1]
        for row in connection.execute(text("PRAGMA table_info(projects)"))
        if row[1] != "bubble_texts_json"
    ]
    rebuilt_table_sql = _drop_column_from_create_table_sql(
        table_sql,
        table_name="projects",
        replacement_table_name="projects_new",
        column_name="bubble_texts_json",
    )
    quoted_columns = ", ".join(f'"{column}"' for column in kept_columns)

    # PRAGMA foreign_keys 只能在 transaction 外切換。
    connection.commit()
    foreign_keys_enabled = bool(
        connection.execute(text("PRAGMA foreign_keys")).scalar_one()
    )
    connection.commit()
    connection.execute(text("PRAGMA foreign_keys = OFF"))
    connection.commit()
    try:
        connection.execute(text("DROP TABLE IF EXISTS projects_new"))
        connection.execute(text(rebuilt_table_sql))
        connection.execute(text(
            f"INSERT INTO projects_new ({quoted_columns}) "
            f"SELECT {quoted_columns} FROM projects"
        ))
        if external_project_trigger_sql is not None:
            # 此 trigger 掛在 students，卻查詢 projects；重建空窗必須先移除，
            # 否則 SQLite 會因 schema 內仍引用已刪除的 main.projects 而拒絕 rename。
            connection.execute(text(
                "DROP TRIGGER trg_students_freeze_class_backed_identity"
            ))
        connection.execute(text("DROP TABLE projects"))
        connection.execute(text("ALTER TABLE projects_new RENAME TO projects"))
        for _, _, create_sql in schema_objects:
            connection.execute(text(create_sql))
        if external_project_trigger_sql is not None:
            connection.execute(text(external_project_trigger_sql))
        violations = list(connection.execute(text("PRAGMA foreign_key_check")))
        if violations:
            raise RuntimeError(
                "projects rebuild produced foreign key violations: "
                f"{violations[:3]}"
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        if foreign_keys_enabled:
            connection.execute(text("PRAGMA foreign_keys = ON"))
            connection.commit()


def _drop_column_from_create_table_sql(
    create_sql: str,
    *,
    table_name: str,
    replacement_table_name: str,
    column_name: str,
) -> str:
    """從 SQLite CREATE TABLE 移除一個頂層欄位定義，保留其餘 constraint。"""
    opening = create_sql.find("(")
    closing = create_sql.rfind(")")
    if opening < 0 or closing <= opening:
        raise RuntimeError(f"無法解析 {table_name} CREATE TABLE")

    clauses = _split_top_level_sql_clauses(create_sql[opening + 1:closing])
    column_pattern = re.compile(
        rf'^\s*(?:"{re.escape(column_name)}"|'
        rf'`{re.escape(column_name)}`|'
        rf'\[{re.escape(column_name)}\]|'
        rf'{re.escape(column_name)})(?:\s|$)',
        re.IGNORECASE,
    )
    quoted_column_pattern = (
        rf'(?:"{re.escape(column_name)}"|'
        rf'`{re.escape(column_name)}`|'
        rf'\[{re.escape(column_name)}\]|'
        rf'{re.escape(column_name)})'
    )
    dependent_foreign_key_pattern = re.compile(
        rf'^\s*(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*'
        rf'\(\s*{quoted_column_pattern}\s*\)',
        re.IGNORECASE,
    )
    matched_columns = [clause for clause in clauses if column_pattern.match(clause)]
    if len(matched_columns) != 1:
        raise RuntimeError(f"無法從 {table_name} schema 唯一識別 {column_name}")
    retained = [
        clause
        for clause in clauses
        if not column_pattern.match(clause)
        and not dependent_foreign_key_pattern.match(clause)
    ]

    prefix = re.sub(
        rf"\b{re.escape(table_name)}\b",
        replacement_table_name,
        create_sql[:opening],
        count=1,
        flags=re.IGNORECASE,
    )
    return f"{prefix}({','.join(retained)}){create_sql[closing + 1:]}"


def _split_top_level_sql_clauses(raw_sql: str) -> list[str]:
    """依最外層逗號切 CREATE TABLE 欄位，保留 DEFAULT/CHECK 內部內容。"""
    clauses: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    index = 0
    while index < len(raw_sql):
        char = raw_sql[index]
        if quote is not None:
            if char == quote:
                if index + 1 < len(raw_sql) and raw_sql[index + 1] == quote:
                    index += 1
                else:
                    quote = None
        elif char in {"'", '"', "`"}:
            quote = char
        elif char == "[":
            quote = "]"
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            clauses.append(raw_sql[start:index])
            start = index + 1
        index += 1
    clauses.append(raw_sql[start:])
    return clauses


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
    if LEGACY_TEACHER_SUPERVISOR_ARCHIVE_TABLE in existing_tables:
        return
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


def _archive_legacy_teacher_supervisor_links(connection):
    """封存舊逐人主管關係後，移除舊 join table 與 users 欄位。"""
    connection.execute(text(f"""
        CREATE TABLE IF NOT EXISTS {LEGACY_TEACHER_SUPERVISOR_ARCHIVE_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            teacher_id INTEGER NOT NULL,
            supervisor_id INTEGER NOT NULL,
            teacher_name_snapshot VARCHAR NOT NULL,
            supervisor_name_snapshot VARCHAR NOT NULL,
            archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (teacher_id, supervisor_id)
        )
    """))

    existing_tables = {
        row[0]
        for row in connection.execute(text(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ))
    }
    user_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(users)"))
    }
    has_single_links = "supervisor_id" in user_columns
    has_many_links = "teacher_supervisors" in existing_tables

    expected_links: dict[tuple[int, int], tuple[str, str]] = {}
    if has_single_links:
        single_rows = connection.execute(text("""
            SELECT teacher.id, teacher.supervisor_id,
                   teacher.display_name, supervisor.display_name
            FROM users AS teacher
            LEFT JOIN users AS supervisor ON supervisor.id = teacher.supervisor_id
            WHERE teacher.supervisor_id IS NOT NULL
        """))
        for teacher_id, supervisor_id, teacher_name, supervisor_name in single_rows:
            if teacher_name is None or supervisor_name is None:
                raise RuntimeError("users.supervisor_id 含無法封存姓名的孤兒關係")
            expected_links[(teacher_id, supervisor_id)] = (
                teacher_name,
                supervisor_name,
            )

    if has_many_links:
        many_rows = connection.execute(text("""
            SELECT links.teacher_id, links.supervisor_id,
                   teacher.display_name, supervisor.display_name
            FROM teacher_supervisors AS links
            LEFT JOIN users AS teacher ON teacher.id = links.teacher_id
            LEFT JOIN users AS supervisor ON supervisor.id = links.supervisor_id
        """))
        for teacher_id, supervisor_id, teacher_name, supervisor_name in many_rows:
            if teacher_name is None or supervisor_name is None:
                raise RuntimeError("teacher_supervisors 含無法封存姓名的孤兒關係")
            expected_links[(teacher_id, supervisor_id)] = (
                teacher_name,
                supervisor_name,
            )

    if expected_links:
        connection.execute(
            text(f"""
                INSERT OR IGNORE INTO {LEGACY_TEACHER_SUPERVISOR_ARCHIVE_TABLE} (
                    teacher_id, supervisor_id,
                    teacher_name_snapshot, supervisor_name_snapshot
                ) VALUES (
                    :teacher_id, :supervisor_id,
                    :teacher_name_snapshot, :supervisor_name_snapshot
                )
            """),
            [
                {
                    "teacher_id": teacher_id,
                    "supervisor_id": supervisor_id,
                    "teacher_name_snapshot": names[0],
                    "supervisor_name_snapshot": names[1],
                }
                for (teacher_id, supervisor_id), names in expected_links.items()
            ],
        )

    archived_links = {
        (row[0], row[1]): (row[2], row[3])
        for row in connection.execute(text(f"""
            SELECT teacher_id, supervisor_id,
                   teacher_name_snapshot, supervisor_name_snapshot
            FROM {LEGACY_TEACHER_SUPERVISOR_ARCHIVE_TABLE}
        """))
    }
    missing_links = set(expected_links) - set(archived_links)
    if missing_links:
        raise RuntimeError(
            "舊逐人主管關係封存不完整："
            f"{sorted(missing_links)[:3]}"
        )
    if any(not all(archived_links[link]) for link in expected_links):
        raise RuntimeError("舊逐人主管關係缺少姓名快照")
    connection.commit()

    if has_many_links:
        connection.execute(text("DROP TABLE teacher_supervisors"))
        connection.commit()
    if has_single_links:
        _drop_users_supervisor_id_column(connection)

    final_tables = {
        row[0]
        for row in connection.execute(text(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ))
    }
    final_user_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(users)"))
    }
    if "teacher_supervisors" in final_tables or "supervisor_id" in final_user_columns:
        raise RuntimeError("舊逐人主管 schema 未完整移除")
    connection.commit()


def _drop_users_supervisor_id_column(connection):
    """移除 users.supervisor_id，舊 SQLite 則動態重建 users table。"""
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(users)"))
    }
    if "supervisor_id" not in existing_columns:
        return

    try:
        connection.execute(text("ALTER TABLE users DROP COLUMN supervisor_id"))
        connection.commit()
        return
    except OperationalError:
        connection.rollback()

    table_sql = connection.execute(text(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'"
    )).scalar_one()
    schema_objects = list(connection.execute(text("""
        SELECT type, name, sql
        FROM sqlite_master
        WHERE tbl_name = 'users'
          AND type IN ('index', 'trigger')
          AND sql IS NOT NULL
        ORDER BY type, name
    """)))
    kept_columns = [
        row[1]
        for row in connection.execute(text("PRAGMA table_info(users)"))
        if row[1] != "supervisor_id"
    ]
    rebuilt_table_sql = _drop_column_from_create_table_sql(
        table_sql,
        table_name="users",
        replacement_table_name="users_new",
        column_name="supervisor_id",
    )
    quoted_columns = ", ".join(f'"{column}"' for column in kept_columns)

    connection.commit()
    foreign_keys_enabled = bool(
        connection.execute(text("PRAGMA foreign_keys")).scalar_one()
    )
    connection.commit()
    connection.execute(text("PRAGMA foreign_keys = OFF"))
    connection.commit()
    try:
        connection.execute(text("DROP TABLE IF EXISTS users_new"))
        connection.execute(text(rebuilt_table_sql))
        connection.execute(text(
            f"INSERT INTO users_new ({quoted_columns}) "
            f"SELECT {quoted_columns} FROM users"
        ))
        connection.execute(text("DROP TABLE users"))
        connection.execute(text("ALTER TABLE users_new RENAME TO users"))
        for _, _, create_sql in schema_objects:
            connection.execute(text(create_sql))
        violations = list(connection.execute(text("PRAGMA foreign_key_check")))
        if violations:
            raise RuntimeError(
                "users rebuild produced foreign key violations: "
                f"{violations[:3]}"
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        if foreign_keys_enabled:
            connection.execute(text("PRAGMA foreign_keys = ON"))
            connection.commit()


def _add_roster_children_and_backfill(connection):
    """只建立名冊 schema；舊 Student 身分一律等待管理員顯式遷移。

    舊版已寫入的 non-NULL link 原樣保存為 provisional evidence；fresh legacy
    Student 保持 NULL，絕不依姓名建立或共用 RosterChild。
    """
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
    existing_columns = {
        row[1]
        for row in connection.execute(text("PRAGMA table_info(students)"))
    }
    if "roster_child_id" not in existing_columns:
        connection.execute(text(
            "ALTER TABLE students ADD COLUMN roster_child_id INTEGER "
            "REFERENCES roster_children(id)"
        ))
    connection.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_students_roster_child_id ON students (roster_child_id)"
    ))

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
