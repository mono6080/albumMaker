"""編班之後，把看板新建的新生補上學號。**預設 dry-run，`--apply` 才寫入。**

為什麼需要它：編班看板的「＋新生」走 `batch_add_classroom_members`，那個端點只收
姓名與相本稱呼，收不到學號。於是新生的 `students.student_serial` 是空的，而學號正是
名冊同步唯一的對應鍵——沒有學號的孩子在漂移報告裡永遠對不到上游，還會被誤判成
「上游有、相本沒有」而重複建檔（`report_websystem_drift` 已擋下並改列待審）。

配對方式是（分校，班級，姓名）——**只用在這一步**，而且是對著剛剛才由同一份上游資料
建出來的新生，不是拿姓名當長期的鍵。同班同名會被跳過並列出來，由人決定。

用法：

    python scripts/backfill_new_student_serials.py --db <db> --upstream <快照.db>
    python scripts/backfill_new_student_serials.py --db <db> --upstream <快照.db> --apply
"""
import argparse
import pathlib
import sqlite3
import sys
import unicodedata

# 與 report_websystem_drift 同一組：行政系統用這些後綴標記同名不同人
NAME_DISAMBIGUATION_SUFFIXES = ".*．·。 　"


def normalize_name(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", value or "").replace(" ", "").replace("　", "")
    return text.rstrip(NAME_DISAMBIGUATION_SUFFIXES)


def covers(on_date: str | None, off_date: str | None, day: str) -> bool:
    """行政系統把 offDate 填成學期結束日而不是留 NULL，在籍要用日期區間判定。"""
    if on_date and on_date > day:
        return False
    if off_date and off_date < day:
        return False
    return True


def open_readonly(path: pathlib.Path) -> sqlite3.Connection:
    if not path.is_file():
        sys.exit(f"找不到資料庫：{path}")
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=pathlib.Path, required=True)
    parser.add_argument("--upstream", type=pathlib.Path, required=True)
    parser.add_argument("--as-of", required=True, help="編班基準日 YYYY-MM-DD")
    parser.add_argument("--semester-id", type=int, default=None,
                        help="上游學期 id；預設用相本系統目前學期的 starts_on 去對")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    album = sqlite3.connect(args.db)
    album.row_factory = sqlite3.Row
    upstream = open_readonly(args.upstream)

    semester = album.execute(
        "select id, label, starts_on from semesters where status in ('imported', 'active')"
    ).fetchone()
    if semester is None:
        sys.exit("相本系統沒有 imported/active 狀態的學期")

    if args.semester_id is not None:
        upstream_semester_id = args.semester_id
    else:
        row = upstream.execute(
            "select id from school_semester where startDate = ?", (semester["starts_on"],)
        ).fetchone()
        if row is None:
            sys.exit(f"行政系統找不到 startDate={semester['starts_on']} 的學期")
        upstream_semester_id = row["id"]

    # 上游該學期的在籍名單，key 是（分校，班名，正規化姓名）
    upstream_by_place: dict[tuple[str, str, str], list[dict]] = {}
    for row in upstream.execute(
        """
        select cp.name campus, c.name room, p.name, s.studentSerial serial,
               l.onDate, l.offDate
          from student_claslog l
          join school_clas c on c.id = l.clas_id
          join school_campus cp on cp.id = c.campus_id
          join student_student s on s.id = l.student_id
          join core_person p on p.id = s.person_id
         where c.semester_id = ?
        """,
        (upstream_semester_id,),
    ):
        if not covers(row["onDate"], row["offDate"], args.as_of):
            continue
        key = (row["campus"], row["room"], normalize_name(row["name"]))
        upstream_by_place.setdefault(key, []).append(dict(row))

    # 相本系統這一期沒有學號的在籍孩子
    targets = [
        dict(row)
        for row in album.execute(
            """
            select s.id student_id, s.name, cr.name room, cp.name campus
              from classroom_members m
              join students s on s.id = m.roster_child_id
              join classrooms cr on cr.id = m.classroom_id
              join campuses cp on cp.id = cr.campus_id
             where m.ended_at is null
               and cr.semester_id = ?
               and s.student_serial is null
            """,
            (semester["id"],),
        )
    ]
    taken = {
        row["student_serial"]
        for row in album.execute(
            "select student_serial from students where student_serial is not null"
        )
    }

    matched, ambiguous, unmatched, already_taken = [], [], [], []
    for child in targets:
        key = (child["campus"], child["room"], normalize_name(child["name"]))
        candidates = upstream_by_place.get(key, [])
        if not candidates:
            unmatched.append(child)
        elif len(candidates) > 1:
            ambiguous.append((child, [c["serial"] for c in candidates]))
        elif candidates[0]["serial"] in taken:
            already_taken.append((child, candidates[0]["serial"]))
        else:
            matched.append((child, candidates[0]["serial"]))
            taken.add(candidates[0]["serial"])

    print(f"相本系統目前學期：{semester['label']}　基準日 {args.as_of}")
    print(f"沒有學號的在籍孩子 {len(targets)} 位")
    print(f"  可回填      {len(matched)}")
    print(f"  同班同名多筆 {len(ambiguous)}")
    print(f"  上游查無     {len(unmatched)}")
    print(f"  學號已被占用 {len(already_taken)}")
    for child, serials in ambiguous:
        print(f"    ？{child['campus']}／{child['room']} {child['name']} → {serials}")
    for child in unmatched:
        print(f"    ！{child['campus']}／{child['room']} {child['name']} 在上游找不到")
    for child, serial in already_taken:
        print(f"    ！{child['campus']}／{child['room']} {child['name']} 的 {serial} 已被其他人使用")

    if not args.apply:
        print("\n（dry-run，未寫入。加 --apply 才會寫）")
        return 0

    for child, serial in matched:
        album.execute(
            "update students set student_serial = ? where id = ?", (serial, child["student_id"])
        )
    album.commit()
    print(f"\n已回填 {len(matched)} 位。")
    remaining = album.execute(
        """
        select count(*) from classroom_members m
          join students s on s.id = m.roster_child_id
          join classrooms cr on cr.id = m.classroom_id
         where m.ended_at is null and cr.semester_id = ? and s.student_serial is null
        """,
        (semester["id"],),
    ).fetchone()[0]
    print(f"仍沒有學號的在籍孩子 {remaining} 位。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
