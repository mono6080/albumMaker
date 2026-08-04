"""編班後回填新生學號的配對規則。

這一步存在的原因：編班看板的「＋新生」走 `batch_add_classroom_members`，那個端點只收
姓名，收不到學號；而學號是名冊同步唯一的對應鍵。2026-08-04 的正式資料演練裡，編班
產生 44 位沒有學號的孩子，回填後漂移才從 88 筆降到 0。

配對用（分校，班級，姓名），只用在這一步——所以「同班同名」與「學號已被占用」這兩個
會出錯而且錯了不會報錯的情境必須釘住。
"""
from __future__ import annotations

import sqlite3

from scripts import backfill_new_student_serials as backfill


def test_name_suffix_is_stripped_but_a_real_difference_is_kept():
    """行政系統用姓名後綴標記同名不同人，那不是名字的一部分。"""
    assert backfill.normalize_name("陳又愷.") == backfill.normalize_name("陳又愷")
    assert backfill.normalize_name("郭芯妍..") == backfill.normalize_name("郭芯妍")
    assert backfill.normalize_name("陳宥希") != backfill.normalize_name("陳侑希")


def test_enrolment_uses_date_range_not_null_offdate():
    """行政系統把 offDate 填成學期結束日，不是留 NULL。"""
    assert backfill.covers("2026-08-01", "2027-01-31", "2026-08-04") is True
    assert backfill.covers("2026-09-01", "2027-01-31", "2026-08-04") is False
    assert backfill.covers("2026-08-01", "2026-08-03", "2026-08-04") is False


def _album_db(children):
    """children: [(name, room, serial)]，serial 為 None 代表看板新建的新生。"""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        create table semesters (id integer primary key, label text, status text,
                                starts_on text, ends_on text);
        create table campuses (id integer primary key, name text);
        create table classrooms (id integer primary key, name text, campus_id integer,
                                 semester_id integer);
        create table students (id integer primary key, name text, student_serial text);
        create table classroom_members (id integer primary key, roster_child_id integer,
                                        classroom_id integer, ended_at text);
        insert into semesters values (1, '115上', 'active', '2026-08-01', '2027-01-31');
        insert into campuses values (1, '安平校');
        insert into classrooms values (1, '三階A', 1, 1), (2, '四階A', 1, 1);
        """
    )
    room_id = {"三階A": 1, "四階A": 2}
    for index, (name, room, serial) in enumerate(children, start=1):
        db.execute("insert into students values (?, ?, ?)", (index, name, serial))
        db.execute(
            "insert into classroom_members values (?, ?, ?, null)",
            (index, index, room_id[room]),
        )
    db.commit()
    return db


def _upstream_db(rows):
    """rows: [(name, room, serial, onDate, offDate)]"""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        create table school_semester (id integer primary key, startDate text);
        create table school_campus (id integer primary key, name text);
        create table school_clas (id integer primary key, name text, campus_id integer,
                                  semester_id integer);
        create table student_student (id integer primary key, studentSerial text,
                                      person_id integer);
        create table core_person (id integer primary key, name text);
        create table student_claslog (id integer primary key, student_id integer,
                                      clas_id integer, onDate text, offDate text);
        insert into school_semester values (23, '2026-08-01');
        insert into school_campus values (1, '安平校');
        insert into school_clas values (1, '三階A', 1, 23), (2, '四階A', 1, 23);
        """
    )
    clas_id = {"三階A": 1, "四階A": 2}
    for index, (name, room, serial, on_date, off_date) in enumerate(rows, start=1):
        db.execute("insert into core_person values (?, ?)", (index, name))
        db.execute("insert into student_student values (?, ?, ?)", (index, serial, index))
        db.execute(
            "insert into student_claslog values (?, ?, ?, ?, ?)",
            (index, index, clas_id[room], on_date, off_date),
        )
    db.commit()
    return db


def _run(monkeypatch, capsys, album, upstream, apply=False):
    monkeypatch.setattr(sqlite3, "connect", lambda *a, **k: album if "mode=ro" not in str(a[0]) else upstream)
    argv = ["--db", "x.db", "--upstream", "y.db", "--as-of", "2026-08-04"]
    if apply:
        argv.append("--apply")
    monkeypatch.setattr(backfill, "open_readonly", lambda _path: upstream)
    import sys as _sys
    monkeypatch.setattr(_sys, "argv", ["backfill_new_student_serials.py", *argv])
    backfill.main()
    return capsys.readouterr().out


def test_matches_by_place_and_name_and_writes_only_with_apply(monkeypatch, capsys):
    album = _album_db([("小明", "三階A", None), ("已有學號的", "三階A", "DN0001")])
    upstream = _upstream_db([
        ("小明", "三階A", "DN0100", "2026-08-01", None),
        ("已有學號的", "三階A", "DN0001", "2026-08-01", None),
    ])

    out = _run(monkeypatch, capsys, album, upstream)
    assert "可回填      1" in out
    assert album.execute("select student_serial from students where id = 1").fetchone()[0] is None

    out = _run(monkeypatch, capsys, album, upstream, apply=True)
    assert "已回填 1 位" in out
    assert album.execute("select student_serial from students where id = 1").fetchone()[0] == "DN0100"


def test_same_name_in_the_same_class_is_never_guessed(monkeypatch, capsys):
    """同班同名沒有辦法用姓名分辨——猜錯就是把兩個孩子的身分對調，而且不會報錯。"""
    album = _album_db([("郭芯妍", "三階A", None)])
    upstream = _upstream_db([
        ("郭芯妍", "三階A", "DN0201", "2026-08-01", None),
        ("郭芯妍.", "三階A", "DN0202", "2026-08-01", None),
    ])

    out = _run(monkeypatch, capsys, album, upstream, apply=True)

    assert "同班同名多筆 1" in out
    assert album.execute("select student_serial from students where id = 1").fetchone()[0] is None


def test_serial_already_used_is_reported_not_duplicated(monkeypatch, capsys):
    """學號有部分唯一索引；硬寫會撞索引，而且代表名冊裡已經有這個孩子了。"""
    album = _album_db([("小明", "三階A", None), ("小明", "四階A", "DN0100")])
    upstream = _upstream_db([("小明", "三階A", "DN0100", "2026-08-01", None)])

    out = _run(monkeypatch, capsys, album, upstream, apply=True)

    assert "學號已被占用 1" in out
    assert album.execute("select student_serial from students where id = 1").fetchone()[0] is None


def test_child_not_yet_enrolled_upstream_is_left_alone(monkeypatch, capsys):
    """入班日還沒到的孩子不算在籍，不該被配上去。"""
    album = _album_db([("小明", "三階A", None)])
    upstream = _upstream_db([("小明", "三階A", "DN0300", "2026-09-01", None)])

    out = _run(monkeypatch, capsys, album, upstream, apply=True)

    assert "上游查無     1" in out
    assert album.execute("select student_serial from students where id = 1").fetchone()[0] is None
