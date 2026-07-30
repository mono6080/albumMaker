"""學期範圍班級重構的行為釘樁：重構前後都必須原封不動通過。

重構會改 ORM 類別名、表名、FK 指向與 API 路徑
（見 docs/specs/term-scoped-classroom-v1.md）。純結構改動不該改變任何
使用者觀察得到的結果，所以這裡釘住四件重構最容易靜默弄壞的事：

    Storage key 格式、渲染指紋的涵蓋範圍、SQLite 改名所依賴的能力、
    以及既有相本的班級顯示。

權限矩陣不在這裡重複釘——test_project_acl_lifecycle.py 已經走 API 覆蓋，
重構後那些測試必須一字不改地通過。
"""

import sqlite3

import pytest
from sqlalchemy import text

from database import engine
from services.output_keys import (
    get_project_output_prefix,
    get_student_image_key,
    get_student_output_prefix,
    get_student_pdf_key,
    get_student_render_state_key,
)
from services.student_render_service import _RENDER_PIPELINE_FILES
from tests.helpers import started_client


# ── Storage key ───────────────────────────────────────────────────────────────
# R8：key 由整數 id 推導、與表名無關。改名時若有人順手把 "student" 字面值
# 一起換掉，16,126 張既有照片與輸出會全部定位不到，而且不會有任何錯誤訊息。

def test_storage_keys_are_derived_from_ids_not_model_names():
    assert get_project_output_prefix(7) == "projects/proj7/output"
    assert get_student_output_prefix(7, 42) == "projects/proj7/output/students/student42"
    assert get_student_pdf_key(7, 42) == (
        "projects/proj7/output/students/student42/pdf/print.pdf"
    )
    assert get_student_image_key(7, 42, "print", 3) == (
        "projects/proj7/output/students/student42/images/print/page3.jpg"
    )
    assert get_student_render_state_key(7, 42) == (
        "projects/proj7/output/students/student42/.render_state"
    )


# ── 渲染指紋 ──────────────────────────────────────────────────────────────────
# R1：指紋雜湊這些檔案的「檔名 + 內容」，內容一動就讓所有 .render_state 過期。
# 改名會動到其中兩個檔，重渲染無法避免；這個測試只保證「涵蓋範圍」不被順手
# 改掉——多一個或少一個檔案都會讓失效判斷從此不準。

def test_render_pipeline_fingerprint_covers_exactly_the_declared_sources():
    covered = sorted(path.name for path in _RENDER_PIPELINE_FILES)
    python_sources = [name for name in covered if name.endswith(".py")]
    assert python_sources == [
        "draw_helpers.py",
        "element_renderers.py",
        "label_texts.py",
        "layout_group_traversal.py",
        "layout_group_validation.py",
        "photo_frame_geometry.py",
        "render_image_loader.py",
        "render_service.py",
        "student_render_service.py",
        "text_layout.py",
        "text_variables.py",
    ]
    # design tokens 與字型 manifest：manifest 檔名依平台解析，只確認兩個資產都在
    assert [name for name in covered if not name.endswith(".py")] == [
        "design_tokens.json",
        "manifest.json",
    ]
    assert all(path.is_file() for path in _RENDER_PIPELINE_FILES)


# ── SQLite 能力 ───────────────────────────────────────────────────────────────
# R4：ALTER TABLE RENAME 只有在 SQLite >= 3.25 才會改寫 trigger 與 view 裡的
# 參照；REFERENCES 子句則要 foreign_keys=ON 才會跟著改。任一條不成立，改名會
# 靜默留下指向舊表名的 FK 與 trigger，而不是報錯。

def test_sqlite_can_rewrite_references_on_table_rename():
    assert sqlite3.sqlite_version_info >= (3, 25, 0), (
        f"ALTER TABLE RENAME 的參照改寫需要 SQLite >= 3.25，"
        f"目前 {sqlite3.sqlite_version}"
    )
    with engine.connect() as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar() == 1
        assert connection.execute(text("PRAGMA legacy_alter_table")).scalar() == 0


def test_table_rename_rewrites_foreign_keys_and_triggers():
    """用一次真的改名驗證環境行為，而不是只相信版本號。"""
    connection = sqlite3.connect(":memory:")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.executescript("""
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER REFERENCES parents(id)
        );
        CREATE TRIGGER trg_children_guard BEFORE UPDATE ON children
        WHEN NOT EXISTS (SELECT 1 FROM parents WHERE parents.id = NEW.parent_id)
        BEGIN SELECT RAISE(ABORT, 'orphan'); END;
    """)
    connection.execute("ALTER TABLE parents RENAME TO guardians")

    child_sql = connection.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'children'"
    ).fetchone()[0]
    trigger_sql = connection.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'trg_children_guard'"
    ).fetchone()[0]
    assert "guardians" in child_sql and "parents" not in child_sql
    assert "guardians" in trigger_sql and "parents" not in trigger_sql
    connection.close()


def test_dropping_a_column_referenced_by_trigger_is_rejected():
    """R2：projects.classroom_id 被 4 個 trigger 參照，必須先 drop trigger。

    這個測試釘住 SQLite 的實際行為，讓 migration 的步驟順序有依據——
    不是「保險起見先 drop」，而是「不先 drop 就會失敗」。
    """
    connection = sqlite3.connect(":memory:")
    connection.executescript("""
        CREATE TABLE projects (id INTEGER PRIMARY KEY, classroom_id INTEGER);
        CREATE TRIGGER trg_projects_guard BEFORE UPDATE OF classroom_id ON projects
        WHEN NEW.classroom_id IS NULL
        BEGIN SELECT RAISE(ABORT, 'nope'); END;
    """)
    with pytest.raises(sqlite3.OperationalError):
        connection.execute("ALTER TABLE projects DROP COLUMN classroom_id")

    connection.execute("DROP TRIGGER trg_projects_guard")
    connection.execute("ALTER TABLE projects DROP COLUMN classroom_id")
    remaining = [row[1] for row in connection.execute("PRAGMA table_info(projects)")]
    assert remaining == ["id"]
    connection.close()


# ── 授權不依賴 model 身分 ─────────────────────────────────────────────────────
# R9：Django 的 auth_permission 綁 content_type，搬 model 會讓權限列指向不存在
# 的身分。這裡的授權完全由 runtime 從 role 字串與整數 FK 算出來，沒有任何一張表
# 把 model 名或表名當資料存——這個測試確保之後也不會有人加進來。

AUTHORIZATION_TABLES = (
    "users",
    "classroom_teacher_assignments",
    "organization_supervisor_assignments",
    "project_editor_assignments",
)
MODEL_IDENTITY_COLUMN_HINTS = (
    "content_type",
    "model_name",
    "app_label",
    "table_name",
    "entity_type",
    "object_type",
)


def test_authorization_tables_do_not_store_model_identity():
    with started_client(), engine.connect() as connection:
        for table_name in AUTHORIZATION_TABLES:
            columns = [
                row[1]
                for row in connection.execute(text(f"PRAGMA table_info({table_name})"))
            ]
            assert columns, f"授權表 {table_name} 不存在"
            offenders = [
                column
                for column in columns
                if any(hint in column.lower() for hint in MODEL_IDENTITY_COLUMN_HINTS)
            ]
            assert not offenders, (
                f"{table_name} 出現以 model 身分為鍵的欄位 {offenders}；"
                "授權必須只依賴 role 與整數 FK，否則改名／搬 model 會讓權限失準"
            )
