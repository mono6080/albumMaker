"""行政系統漂移報告的比對規則。

只測純函式與分類邏輯——資料庫讀取在真實副本上驗過，這裡釘住的是「容易錯而且錯了
不會報錯」的兩件事：姓名後綴不可以被當成改名、在籍判定不可以看 offDate 是不是 NULL。
契約見 docs/specs/websystem-roster-sync-v1.md。
"""
from __future__ import annotations

from scripts import report_websystem_drift as drift


def test_disambiguation_suffix_is_not_a_name_change():
    """行政系統用姓名後綴標記同名不同人（郭芯妍 / 郭芯妍. / 郭芯妍..）。

    那是它內部的區分記號，不是孩子名字的一部分——當成改名同步過去，最後會印在相本上。
    """
    for upstream, ours in (
        ("陳又愷.", "陳又愷"),
        ("郭芯妍..", "郭芯妍"),
        ("陳宥希*", "陳宥希"),
        ("陳思羽．", "陳思羽"),
        ("王小明 ", "王小明"),
    ):
        assert drift.normalize_name(upstream) == drift.normalize_name(ours), upstream


def test_real_name_correction_is_still_detected():
    """剝後綴不能連真的改名一起吃掉——2026-08 就更正過 31 筆打錯的姓名。"""
    assert drift.normalize_name("陳宥希") != drift.normalize_name("陳侑希")
    assert drift.normalize_name("林恩熙.") != drift.normalize_name("林恩熹")


def test_enrolment_uses_date_range_not_null_offdate():
    """行政系統把 offDate 填成學期結束日，不是留 NULL。

    用 `offDate is null` 判在籍，會把整個學期的在籍學生都看成已離園——第一次抽資料時
    402 位只認出 4 位就是踩到這裡。
    """
    assert drift.covers("2026-02-01", "2026-07-31", "2026-05-01") is True
    assert drift.covers("2026-02-01", "2026-07-31", "2026-07-31") is True
    assert drift.covers("2026-02-01", "2026-07-31", "2026-08-01") is False
    assert drift.covers("2026-03-01", "2026-07-31", "2026-02-15") is False
    assert drift.covers("2026-02-01", None, "2027-01-01") is True


def _album(members=None, staffing=None, classrooms=None):
    return {
        "semester": {"id": 1, "label": "測試學期", "starts_on": "2026-02-01", "ends_on": "2026-07-31"},
        "classrooms": classrooms if classrooms is not None else {("安平校", "三階A"): {"id": 1}},
        "members": members or {},
        "staffing": staffing or {},
        "serials": {},
        "accounts": {"DN0001": {"display_name": "甲老師"}},
    }


def _upstream(members=None, staffing=None, rooms=None):
    return {
        "semester": {"id": 22, "name": "114下"},
        "rooms": rooms if rooms is not None else {("安平校", "三階A"): {"department": "infant"}},
        "members": members or {},
        "staffing": staffing or {},
    }


def _kinds(rows):
    return sorted({kind for kind, _ in rows})


def test_new_child_is_auto_but_transfer_and_staffing_need_review():
    """分類的理由：新生建檔只會讓資料更完整；換班會撞上重複相本的死結；
    編制異動會即時改變四處權限判斷（相本編輯、轉交、主管範圍、進度報表）。"""
    album = _album(
        members={
            "DN0002": {"name": "留班生", "campus": "安平校", "room": "三階A"},
            "DN0003": {"name": "換班生", "campus": "安平校", "room": "三階A"},
        },
        staffing={("安平校", "三階A", "DN0001"): {"display_name": "甲老師", "duty": "lead"}},
    )
    upstream = _upstream(
        members={
            "DN0002": {"name": "留班生", "campus": "安平校", "room": "三階A"},
            "DN0003": {"name": "換班生", "campus": "安平校", "room": "四階A"},
            "DN0004": {"name": "新生", "campus": "安平校", "room": "三階A"},
        },
        staffing={("安平校", "四階A", "DN0009"): {"name": "乙老師", "duty": "lead"}},
        rooms={("安平校", "三階A"): {}, ("安平校", "四階A"): {}},
    )
    result = drift.diff(album, upstream)

    assert "名冊：新生應建檔並入班" in _kinds(result["auto"])
    review_kinds = _kinds(result["review"])
    assert "名冊：期中換班" in review_kinds
    assert "編制：應新增" in review_kinds, "編制異動一律要人審"
    assert "編制：應結束" in review_kinds
    # 上游多出來的班要人看，不能自動建
    assert "班級：上游有、相本沒有" in review_kinds
    assert not any(kind.startswith("編制") for kind, _ in result["auto"])


def test_departure_is_reported_and_no_drift_means_empty():
    album = _album(members={"DN0002": {"name": "離園生", "campus": "安平校", "room": "三階A"}})
    result = drift.diff(album, _upstream(members={}))
    assert _kinds(result["auto"]) == ["名冊：應離園"]

    same = {"DN0002": {"name": "同一位", "campus": "安平校", "room": "三階A"}}
    quiet = drift.diff(_album(members=same), _upstream(members=same))
    assert quiet["auto"] == [] and quiet["review"] == []


def test_missing_teacher_account_is_flagged_in_the_detail():
    """老師沒有帳號時要在報告裡看得見——115 上就有 1 位（湖美校／四階A 嬰幼助教）。"""
    upstream = _upstream(
        staffing={("安平校", "三階A", "DN9999"): {"name": "無帳號老師", "duty": "co_teacher"}},
    )
    result = drift.diff(_album(), upstream)
    details = [detail for kind, detail in result["review"] if kind == "編制：應新增"]
    assert details and "沒有這個帳號" in details[0]
