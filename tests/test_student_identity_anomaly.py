"""「學生穩定身分異常」判準的兩份實作必須一致。

這條規則是「學期彙整少了一個孩子沒人發現」的唯一防線
（見 known-issues.md 的期中轉班重複相本、academic-term-reporting-v1）。
它有兩個消費者、需要兩種形狀，都住在 `services/student_identity_anomaly.py`：

- `count_assigned_identity_anomalies`：全域筆數，admin 開園所設定時看到的紅字警示。
- `classify_project_student_identity_anomalies`：逐位判斷，決定匯出實際跳過誰、
  說明欄顯示什麼代碼。

兩邊分歧的話會出現「總覽說沒事、匯出靜靜少人」或反過來，而且兩種都不會報錯。
這一檔用同一份資料同時跑兩邊，逼它們對齊。
（2026-08-18 之前計數版是 organization_service 裡一段獨立的 raw SQL，
與逐位版沒有任何東西保證一致。）

（`teacher_overview_service.duplicate_roster_child_ids` **不是**同一條規則：
它找的是同一孩子出現在同一格的**多本**相本，這裡的 duplicate 是同一本裡出現兩次。）
"""
from __future__ import annotations

import sqlite3

import pytest

from services.student_identity_anomaly import (
    DUPLICATE_PROJECT_ROSTER_CHILD,
    INVALID_ROSTER_CHILD,
    MISSING_ROSTER_CHILD,
    classify_project_student_identity_anomalies,
)


@pytest.fixture
def raw_connection():
    """raw 連線用來造出 ORM 造不出來的狀態（例如 dangling FK）。"""
    from database import engine

    con = sqlite3.connect(engine.url.database)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()


def _seed_scaffold(con: sqlite3.Connection) -> tuple[int, int]:
    campus_id = con.execute(
        "insert into campuses (name, is_active) values ('安平校', 1)"
    ).lastrowid
    classroom_id = con.execute(
        "insert into classrooms (semester_id, campus_id, name, department)"
        " values (1, ?, '三階A', 'infant')",
        (campus_id,),
    ).lastrowid
    template_id = con.execute(
        "insert into templates (name, revision) values ('模板', 1)"
    ).lastrowid
    return int(classroom_id), int(template_id)


def _add_project(
    con: sqlite3.Connection,
    template_id: int,
    *,
    classroom_id: int | None,
    deleted: bool = False,
) -> int:
    return int(
        con.execute(
            "insert into projects"
            " (name, template_id, template_revision, label_texts_json,"
            "  classroom_id, deleted_at)"
            " values ('相本', ?, 1, '{}', ?, ?)",
            (template_id, classroom_id, "2026-08-01" if deleted else None),
        ).lastrowid
    )


def _add_child(con: sqlite3.Connection, name: str) -> int:
    return int(
        con.execute("insert into students (name) values (?)", (name,)).lastrowid
    )


def _add_project_student(
    con: sqlite3.Connection, project_id: int, name: str, roster_child_id: int | None
) -> int:
    return int(
        con.execute(
            "insert into project_students (project_id, name, pages_data_json, roster_child_id)"
            " values (?, ?, '[]', ?)",
            (project_id, name, roster_child_id),
        ).lastrowid
    )


def _sql_anomaly_count(session) -> int:
    """走 admin 總覽的正式路徑，確認它真的用到共用判準。"""
    from services.organization_service import _organization_migration_status

    return _organization_migration_status(session)["assigned_identity_anomaly_count"]


def _python_anomaly_student_ids(session) -> set[int]:
    """把 Python 版套用在 SQL 版的同一個 scope 上：已歸班且未刪除。"""
    from database import Project

    projects = (
        session.query(Project)
        .filter(Project.classroom_id.isnot(None), Project.deleted_at.is_(None))
        .all()
    )
    anomalous: set[int] = set()
    for project in projects:
        anomalous.update(classify_project_student_identity_anomalies(project))
    return anomalous


def _session():
    from database import SessionLocal

    return SessionLocal()


def test_clean_roster_link_is_not_an_anomaly(raw_connection):
    classroom_id, template_id = _seed_scaffold(raw_connection)
    project_id = _add_project(raw_connection, template_id, classroom_id=classroom_id)
    child_id = _add_child(raw_connection, "王小明")
    _add_project_student(raw_connection, project_id, "王小明", child_id)
    raw_connection.commit()

    session = _session()
    try:
        assert _python_anomaly_student_ids(session) == set()
        assert _sql_anomaly_count(session) == 0
    finally:
        session.close()


def test_missing_and_dangling_and_duplicate_links_all_count(raw_connection):
    """三種異常各造一個，兩份實作必須看到同一批學生。"""
    classroom_id, template_id = _seed_scaffold(raw_connection)
    project_id = _add_project(raw_connection, template_id, classroom_id=classroom_id)

    missing_id = _add_project_student(raw_connection, project_id, "未連結", None)

    # dangling：FK 是開著的（database.py 的 connect pragma），只有外部 raw SQL 寫入
    # 才造得出來——那正是 INVALID_ROSTER_CHILD 存在的理由。
    raw_connection.execute("PRAGMA foreign_keys=OFF")
    dangling_id = _add_project_student(raw_connection, project_id, "指向不存在", 999_999)
    raw_connection.execute("PRAGMA foreign_keys=ON")

    shared_child_id = _add_child(raw_connection, "重複收錄")
    first_id = _add_project_student(raw_connection, project_id, "重複收錄", shared_child_id)
    second_id = _add_project_student(raw_connection, project_id, "重複收錄", shared_child_id)
    raw_connection.commit()

    session = _session()
    try:
        anomalous = _python_anomaly_student_ids(session)
        assert anomalous == {missing_id, dangling_id, first_id, second_id}
        assert _sql_anomaly_count(session) == len(anomalous)
    finally:
        session.close()


def test_anomaly_codes_name_the_actual_problem(raw_connection):
    """匯出的說明欄直接顯示這些代碼，錯配等於告訴使用者錯的原因。"""
    from database import Project

    classroom_id, template_id = _seed_scaffold(raw_connection)
    project_id = _add_project(raw_connection, template_id, classroom_id=classroom_id)
    missing_id = _add_project_student(raw_connection, project_id, "未連結", None)
    raw_connection.execute("PRAGMA foreign_keys=OFF")
    dangling_id = _add_project_student(raw_connection, project_id, "指向不存在", 999_999)
    raw_connection.execute("PRAGMA foreign_keys=ON")
    shared_child_id = _add_child(raw_connection, "重複收錄")
    first_id = _add_project_student(raw_connection, project_id, "甲", shared_child_id)
    _add_project_student(raw_connection, project_id, "乙", shared_child_id)
    raw_connection.commit()

    session = _session()
    try:
        project = session.query(Project).filter(Project.id == project_id).one()
        codes = classify_project_student_identity_anomalies(project)
        assert codes[missing_id] == (MISSING_ROSTER_CHILD,)
        assert codes[dangling_id] == (INVALID_ROSTER_CHILD,)
        assert codes[first_id] == (DUPLICATE_PROJECT_ROSTER_CHILD,)
    finally:
        session.close()


def test_deleted_and_unassigned_projects_stay_out_of_the_global_count(raw_connection):
    """全域警示只看已歸班且未刪除的相本；未歸班舊相本另有 pending 佇列。"""
    classroom_id, template_id = _seed_scaffold(raw_connection)
    deleted_project_id = _add_project(
        raw_connection, template_id, classroom_id=classroom_id, deleted=True
    )
    _add_project_student(raw_connection, deleted_project_id, "已刪相本裡的異常", None)
    unassigned_project_id = _add_project(raw_connection, template_id, classroom_id=None)
    _add_project_student(raw_connection, unassigned_project_id, "未歸班的異常", None)
    raw_connection.commit()

    session = _session()
    try:
        assert _python_anomaly_student_ids(session) == set()
        assert _sql_anomaly_count(session) == 0
    finally:
        session.close()


def test_duplicate_is_scoped_to_one_project_not_across_projects(raw_connection):
    """同一孩子出現在**兩本不同**相本不是這條規則的異常。

    那是「一格多本」，由 teacher_overview 的 duplicate_roster_child_ids 與匯出的
    duplicate cell 處理，判準與這裡不同——合併兩者會把正常的一格多本誤報成身分異常。
    """
    classroom_id, template_id = _seed_scaffold(raw_connection)
    first_project_id = _add_project(raw_connection, template_id, classroom_id=classroom_id)
    second_project_id = _add_project(raw_connection, template_id, classroom_id=classroom_id)
    child_id = _add_child(raw_connection, "王小明")
    _add_project_student(raw_connection, first_project_id, "王小明", child_id)
    _add_project_student(raw_connection, second_project_id, "王小明", child_id)
    raw_connection.commit()

    session = _session()
    try:
        assert _python_anomaly_student_ids(session) == set()
        assert _sql_anomaly_count(session) == 0
    finally:
        session.close()
