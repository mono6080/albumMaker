"""行政系統同步的**寫入端**契約（`sync_websystem_roster.apply_changes`）。

分類邏輯由 `test_websystem_drift_report.py` 蓋住（哪些算自動、哪些要人工）。
這一檔釘的是另一半：判斷對了之後，實際寫進正式名冊的東西對不對。

那支腳本是全案唯一「排程每天跑、由容器外另一個 process、用 raw SQL 改正式名冊」的
路徑，寫錯不會報錯，只會安靜地把資料改成別的樣子。

**schema 一律用真的 migration 建**（conftest 的 `_isolated_database`），不手刻。
一次性遷移腳本的測試曾各自手刻舊 schema，結果表改名之後腳本早就跑不動、CI 卻一直全綠。
"""
from __future__ import annotations

import sqlite3

import pytest

from scripts.report_websystem_drift import load_album_state
from scripts.sync_websystem_roster import apply_changes

CAMPUS = "安平校"
ROOM = "三階A"
# apply_changes 只看 auto_kinds 非空，逐項行為由 album/upstream 的差異決定
ALL_AUTO_KINDS = [
    ("名冊：姓名不符", "-"),
    ("名冊：新生應建檔並入班", "-"),
    ("名冊：應入班", "-"),
    ("名冊：應離園", "-"),
]


@pytest.fixture
def connection():
    """對 conftest 那份跑過真 migration 的資料庫開一條 raw 連線。"""
    from database import engine

    con = sqlite3.connect(engine.url.database)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
    finally:
        con.close()


def _seed_classroom(con: sqlite3.Connection, *, room: str = ROOM) -> int:
    row = con.execute("select id from campuses where name = ?", (CAMPUS,)).fetchone()
    if row is None:
        campus_id = con.execute(
            "insert into campuses (name, is_active) values (?, 1)", (CAMPUS,)
        ).lastrowid
    else:
        campus_id = int(row["id"])
    return int(
        con.execute(
            "insert into classrooms (semester_id, campus_id, name, department)"
            " values (1, ?, ?, 'infant')",
            (campus_id, room),
        ).lastrowid
    )


def _seed_child(
    con: sqlite3.Connection,
    name: str,
    serial: str | None,
    *,
    classroom_id: int | None = None,
) -> int:
    """建一位名冊孩子；給 classroom_id 就同時放進在班區間。"""
    child_id = int(
        con.execute(
            "insert into students (name, student_serial) values (?, ?)", (name, serial)
        ).lastrowid
    )
    if classroom_id is not None:
        con.execute(
            "insert into classroom_members (classroom_id, roster_child_id, started_at)"
            " values (?, ?, '2026-02-01')",
            (classroom_id, child_id),
        )
    return child_id


def _seed_unfinished_album(con: sqlite3.Connection, child_id: int, name: str) -> None:
    """替某位孩子建一本製作中的相本（相本與學生都未標記完成）。"""
    template_id = int(
        con.execute("insert into templates (name, revision) values ('模板', 1)").lastrowid
    )
    project_id = int(
        con.execute(
            "insert into projects (name, template_id, template_revision, label_texts_json)"
            " values ('相本', ?, 1, '{}')",
            (template_id,),
        ).lastrowid
    )
    con.execute(
        "insert into project_students (project_id, name, pages_data_json, roster_child_id)"
        " values (?, ?, '[]', ?)",
        (project_id, name, child_id),
    )


def _upstream(*members: dict) -> dict:
    return {
        "members": {
            member["serial"]: {
                "serial": member["serial"],
                "name": member["name"],
                "campus": member.get("campus", CAMPUS),
                "room": member.get("room", ROOM),
            }
            for member in members
        }
    }


def _apply(con: sqlite3.Connection, upstream: dict, *, auto=None) -> list[str]:
    album = load_album_state(con)
    con.execute("BEGIN IMMEDIATE")
    log = apply_changes(
        con,
        album,
        upstream,
        {"auto": ALL_AUTO_KINDS if auto is None else auto},
        snapshot_label="測試快照",
    )
    con.commit()
    return log


def _roster(con: sqlite3.Connection) -> list[tuple]:
    return [
        (row["name"], row["student_serial"])
        for row in con.execute(
            "select name, student_serial from students order by id"
        )
    ]


def _memberships(con: sqlite3.Connection) -> list[tuple]:
    return [
        (row["roster_child_id"], row["ended_at"] is not None, row["end_reason"])
        for row in con.execute(
            "select roster_child_id, ended_at, end_reason from classroom_members order by id"
        )
    ]


def test_name_correction_updates_the_roster_child_and_leaves_membership_alone(connection):
    """改名改的是名冊項本身，不該連帶動到在班區間。"""
    classroom_id = _seed_classroom(connection)
    child_id = _seed_child(connection, "陳侑希", "A001", classroom_id=classroom_id)
    connection.commit()

    _apply(connection, _upstream({"serial": "A001", "name": "陳宥希"}))

    assert _roster(connection) == [("陳宥希", "A001")]
    assert _memberships(connection) == [(child_id, False, None)]


def test_disambiguation_suffix_is_stripped_before_it_reaches_the_roster(connection):
    """上游用姓名後綴標記同名不同人；那是它的內部記號，照搬會印在相本上。"""
    classroom_id = _seed_classroom(connection)
    _seed_child(connection, "郭芯妍", "A001", classroom_id=classroom_id)
    connection.commit()

    _apply(connection, _upstream({"serial": "A001", "name": "郭芯妍.."}))

    assert _roster(connection) == [("郭芯妍", "A001")]


def test_new_child_is_created_then_enrolled(connection):
    """名冊完全沒有這個學號：先建名冊項，再補在班區間。"""
    _seed_classroom(connection)
    connection.commit()

    log = _apply(connection, _upstream({"serial": "A003", "name": "陳新生"}))

    assert _roster(connection) == [("陳新生", "A003")]
    new_child_id = connection.execute(
        "select id from students where student_serial = 'A003'"
    ).fetchone()["id"]
    assert _memberships(connection) == [(new_child_id, False, None)]
    assert any("新生建檔" in line for line in log)
    assert any("入班" in line for line in log)


def test_known_serial_is_enrolled_without_creating_a_second_roster_child(connection):
    """已在名冊但不在班（上學期留下來的）：只補在班區間，不可再建一個人。

    重建的話同一個孩子會有兩個 roster_child_id，跨期相本從此對不起來。
    """
    _seed_classroom(connection)
    child_id = _seed_child(connection, "李小華", "A002")  # 有名冊項、沒有在班區間
    connection.commit()

    _apply(connection, _upstream({"serial": "A002", "name": "李小華"}))

    assert _roster(connection) == [("李小華", "A002")]
    assert _memberships(connection) == [(child_id, False, None)]


def test_departure_ends_the_membership_with_a_reason(connection):
    """上游已不在籍：結束在班區間並寫明原因，名冊項本身保留。"""
    classroom_id = _seed_classroom(connection)
    child_id = _seed_child(connection, "李小華", "A002", classroom_id=classroom_id)
    connection.commit()

    _apply(connection, _upstream())

    assert _roster(connection) == [("李小華", "A002")]
    assert _memberships(connection) == [(child_id, True, "departed")]


def test_child_with_an_unfinished_album_is_never_departed(connection):
    """老師可能正在做他的相本；自動結束在班區間會讓那本相本失去歸屬。"""
    classroom_id = _seed_classroom(connection)
    child_id = _seed_child(connection, "李小華", "A002", classroom_id=classroom_id)
    _seed_unfinished_album(connection, child_id, "李小華")
    connection.commit()

    log = _apply(connection, _upstream())

    assert _memberships(connection) == [(child_id, False, None)]
    assert not any("離園" in line for line in log)


def test_unknown_classroom_is_skipped_and_writes_nothing(connection):
    """相本系統沒有這個校／班：記錄下來給人處理，不可自己猜一個班塞進去。"""
    _seed_classroom(connection)
    connection.commit()

    log = _apply(
        connection,
        _upstream({"serial": "A003", "name": "陳新生", "room": "不存在的班"}),
    )

    assert _roster(connection) == []
    assert _memberships(connection) == []
    assert any("跳過 A003" in line for line in log)


def test_no_auto_kinds_writes_nothing(connection):
    """分類結果沒有任何自動項時，整支不得碰資料庫。"""
    classroom_id = _seed_classroom(connection)
    child_id = _seed_child(connection, "李小華", "A002", classroom_id=classroom_id)
    connection.commit()

    log = _apply(connection, _upstream({"serial": "A003", "name": "陳新生"}), auto=[])

    assert log == []
    assert _roster(connection) == [("李小華", "A002")]
    assert _memberships(connection) == [(child_id, False, None)]


def test_serial_is_written_exactly_as_upstream_sent_it(connection):
    """**釘住現況，不是背書。**

    `student_input_policy.normalize_student_serial` 宣告學號是唯一穩定對應鍵、
    必須去空白轉大寫，API 端建名冊時走的就是它。這支腳本沒有——上游給什麼就寫什麼。

    今天沒有實害（正式名冊 466 筆學號全部已符合正規化），但上游哪天送出小寫或帶空白的
    學號，同一個孩子就會多出一個 roster_child_id，而唯一索引不會擋。

    要改的時候先想清楚既有資料：正規化查詢鍵會讓舊的未正規化列比不到，反而製造重複。
    改完這條測試會紅，那是預期的——把它改成斷言正規化後的值。
    """
    from services.student_input_policy import normalize_student_serial

    _seed_classroom(connection)
    connection.commit()

    _apply(connection, _upstream({"serial": " a003 ", "name": "陳新生"}))

    stored = connection.execute(
        "select student_serial from students"
    ).fetchone()["student_serial"]
    assert stored == " a003 "
    assert normalize_student_serial(stored) == "A003"
    assert stored != normalize_student_serial(stored), (
        "學號正規化已補上的話，請改這條測試而不是刪掉它"
    )
