"""比對行政系統與相本系統的組織資料，列出漂移。**唯讀，不寫入任何資料。**

為什麼需要它：相本系統的名冊是 2026-07-17 遷移當天的一次性快照，之後沒有任何機制讓它
跟上；而行政系統一個學期會有 76 件期中異動。漂移的後果全都不會報錯——新生沒有相本、
已離園的孩子被做了相本、升班的孩子在錯的班。在能安全同步之前，得先看得見漂移。

契約（對應鍵、分類、安全閘的理由）見
`docs/specs/websystem-roster-sync-v1.md`。這支只做比對與分類，不做決定。

上游快照怎麼來（正式主機上執行，不要直接讀原檔——WAL 模式下會跟正式流量搶鎖）：

    sudo docker exec production_websystem_web python -c \
      "import sqlite3; s=sqlite3.connect('/webSystem/db.sqlite3'); \
       d=sqlite3.connect('/webSystem/_drift_snapshot.db'); s.backup(d)"

用法：

    python scripts/report_websystem_drift.py --upstream <快照.db> --db backend/album_maker.db
    python scripts/report_websystem_drift.py --upstream ... --db ... --as-of 2026-07-31
"""
import argparse
import datetime as dt
import pathlib
import sqlite3
import sys
import unicodedata

# 八/九/十階屬學院部，其餘嬰幼部。與 build_ui_plan 的判定一致。
ACADEMY_GRADES = {"八階", "九階", "十階"}


# 行政系統用姓名後綴標記同名不同人（實例：郭芯妍 / 郭芯妍. / 郭芯妍..）。那是它內部的
# 區分記號，不是孩子名字的一部分——照搬過來會印在相本上。比對前一律去掉。
NAME_DISAMBIGUATION_SUFFIXES = ".*．·。 　"


def normalize_name(value: str | None) -> str:
    """比對姓名用：全形正規化、去空白，並剝掉行政系統的同名區分後綴。

    只用於「同一個學號的姓名是否一致」，**絕不用來配對人**——姓名永遠不是可靠的鍵，
    識別一律用學號。
    """
    text = unicodedata.normalize("NFKC", value or "").replace(" ", "").replace("　", "")
    return text.rstrip(NAME_DISAMBIGUATION_SUFFIXES)


def covers(on_date: str | None, off_date: str | None, day: str) -> bool:
    """行政系統的 claslog／postlog 不是用 offDate=NULL 表示在籍，而是把 offDate 填成
    學期結束日，所以在籍判定必須用「日期區間涵蓋該日」。"""
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


def load_album_state(db: sqlite3.Connection) -> dict:
    semester = db.execute(
        "select id, label, starts_on, ends_on from semesters where status = 'imported'"
    ).fetchone()
    if semester is None:
        sys.exit("相本系統沒有 imported 狀態的學期，無法判斷目前學期")

    classrooms = {}
    for row in db.execute(
        """
        select cr.id, cr.name, cr.department, cp.name campus
          from classrooms cr join campuses cp on cp.id = cr.campus_id
         where cr.semester_id = ?
        """,
        (semester["id"],),
    ):
        classrooms[(row["campus"], row["name"])] = dict(row)

    members = {}
    for row in db.execute(
        """
        select m.id member_id, s.id student_id, s.name, s.student_serial,
               cr.name room, cp.name campus
          from classroom_members m
          join students s on s.id = m.roster_child_id
          join classrooms cr on cr.id = m.classroom_id
          join campuses cp on cp.id = cr.campus_id
         where m.ended_at is null and cr.semester_id = ?
        """,
        (semester["id"],),
    ):
        members[row["student_serial"]] = dict(row)

    staffing = {}
    for row in db.execute(
        """
        select u.username, u.display_name, ct.duty, cr.name room, cp.name campus
          from classroom_teachers ct
          join users u on u.id = ct.teacher_id
          join classrooms cr on cr.id = ct.classroom_id
          join campuses cp on cp.id = cr.campus_id
         where ct.ended_at is null and cr.semester_id = ?
        """,
        (semester["id"],),
    ):
        staffing[(row["campus"], row["room"], row["username"])] = dict(row)

    # 有製作中相本的孩子：離園要改走待審，不能自動結束在班區間——老師可能正在做他的相本
    in_progress = {
        row["student_serial"]
        for row in db.execute(
            """
            select distinct s.student_serial
              from project_students ps
              join projects pr on pr.id = ps.project_id
              join students s on s.id = ps.roster_child_id
             where pr.deleted_at is null
               and pr.completed_at is null
               and ps.completed_at is null
               and s.student_serial is not null
            """
        )
    }

    serials = {
        row["student_serial"]: dict(row)
        for row in db.execute(
            "select id, name, student_serial from students where student_serial is not null"
        )
    }
    accounts = {
        row["username"]: dict(row)
        for row in db.execute("select username, display_name from users")
    }
    return {
        "semester": dict(semester),
        "classrooms": classrooms,
        "members": members,
        "staffing": staffing,
        "serials": serials,
        "accounts": accounts,
        "in_progress": in_progress,
    }


def load_upstream_state(up: sqlite3.Connection, starts_on: str, as_of: str) -> dict:
    semester = up.execute(
        "select id, name from school_semester where startDate = ?", (starts_on,)
    ).fetchone()
    if semester is None:
        sys.exit(f"行政系統找不到 startDate={starts_on} 的學期，無法對應")

    campuses = {row["id"]: row["name"] for row in up.execute("select id, name from school_campus")}
    grades = {row["id"]: row["name"] for row in up.execute("select id, name from school_grade")}
    classes = {}
    for row in up.execute(
        "select id, name, campus_id, grade_id from school_clas where semester_id = ?",
        (semester["id"],),
    ):
        classes[row["id"]] = {
            "name": row["name"],
            "campus": campuses.get(row["campus_id"]),
            "grade": grades.get(row["grade_id"]),
        }
    if not classes:
        sys.exit(f"行政系統的 {semester['name']} 沒有班級")

    placeholders = ",".join(str(i) for i in classes)
    members = {}
    for row in up.execute(
        f"""
        select l.clas_id, l.onDate, l.offDate, s.studentSerial serial, p.name
          from student_claslog l
          join student_student s on s.id = l.student_id
          join core_person p on p.id = s.person_id
         where l.clas_id in ({placeholders})
        """
    ):
        if not covers(row["onDate"], row["offDate"], as_of):
            continue
        room = classes[row["clas_id"]]
        members[row["serial"]] = {
            "serial": row["serial"],
            "name": row["name"],
            "campus": room["campus"],
            "room": room["name"],
        }

    posts = {row["id"]: row["name"] for row in up.execute("select id, name from personnel_post")}
    staffing = {}
    for row in up.execute(
        f"""
        select g.clas_id, g.onDate, g.offDate, g.post_id,
               st.staffSerial serial, p.name
          from personnel_postlog g
          join personnel_staff st on st.id = g.staff_id
          join core_person p on p.id = st.person_id
         where g.clas_id in ({placeholders})
        """
    ):
        if not covers(row["onDate"], row["offDate"], as_of):
            continue
        room = classes[row["clas_id"]]
        post = posts.get(row["post_id"]) or ""
        staffing[(room["campus"], room["name"], row["serial"])] = {
            "serial": row["serial"],
            "name": row["name"],
            "campus": room["campus"],
            "room": room["name"],
            "duty": "lead" if ("主教" in post or "組長" in post) else "co_teacher",
            "post": post,
        }

    rooms = {
        (room["campus"], room["name"]): {
            **room,
            "department": "academy" if room["grade"] in ACADEMY_GRADES else "infant",
        }
        for room in classes.values()
    }
    return {"semester": dict(semester), "rooms": rooms, "members": members, "staffing": staffing}


def diff(album: dict, upstream: dict) -> dict:
    auto, review = [], []

    # ── 班級 ──────────────────────────────────────────────────────────────
    for key in sorted(set(upstream["rooms"]) - set(album["classrooms"])):
        review.append(("班級：上游有、相本沒有", f"{key[0]}／{key[1]}"))
    for key in sorted(set(album["classrooms"]) - set(upstream["rooms"])):
        review.append(("班級：相本有、上游沒有", f"{key[0]}／{key[1]}"))

    # ── 名冊與編班 ────────────────────────────────────────────────────────
    for serial, up_member in sorted(upstream["members"].items()):
        here = album["members"].get(serial)
        if here is None:
            known = album["serials"].get(serial)
            label = f"{up_member['name']}（{serial}）→ {up_member['campus']}／{up_member['room']}"
            auto.append(("名冊：應入班" if known else "名冊：新生應建檔並入班", label))
            continue
        if (here["campus"], here["room"]) != (up_member["campus"], up_member["room"]):
            review.append((
                "名冊：期中換班",
                f"{up_member['name']}（{serial}）"
                f" {here['campus']}／{here['room']} → {up_member['campus']}／{up_member['room']}",
            ))
        if normalize_name(here["name"]) != normalize_name(up_member["name"]):
            auto.append((
                "名冊：姓名不符",
                f"{serial} 相本「{here['name']}」 vs 行政「{up_member['name']}」",
            ))
    for serial, here in sorted(album["members"].items()):
        if serial not in upstream["members"]:
            detail = f"{here['name']}（{serial}）目前在 {here['campus']}／{here['room']}"
            if serial in album.get("in_progress", set()):
                review.append(("名冊：應離園但有製作中相本", detail))
            else:
                auto.append(("名冊：應離園", detail))

    # ── 老師編制（一律待審：會即時改變四處權限判斷）────────────────────────
    for key, up_row in sorted(upstream["staffing"].items()):
        if key not in album["staffing"]:
            missing = "（相本系統沒有這個帳號）" if key[2] not in album["accounts"] else ""
            review.append((
                "編制：應新增",
                f"{up_row['name']}（{key[2]}）→ {key[0]}／{key[1]} {up_row['duty']}{missing}",
            ))
        elif album["staffing"][key]["duty"] != up_row["duty"]:
            review.append((
                "編制：職責不符",
                f"{up_row['name']} {key[0]}／{key[1]}"
                f" 相本 {album['staffing'][key]['duty']} vs 行政 {up_row['duty']}",
            ))
    for key, here in sorted(album["staffing"].items()):
        if key not in upstream["staffing"]:
            review.append((
                "編制：應結束",
                f"{here['display_name']}（{key[2]}）目前掛 {key[0]}／{key[1]}",
            ))
    return {"auto": auto, "review": review}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=pathlib.Path, required=True,
                        help="行政系統的 SQLite 快照（不要指向正在服務的原檔）")
    parser.add_argument("--db", type=pathlib.Path, required=True, help="相本系統資料庫")
    parser.add_argument("--as-of", default=None,
                        help="以哪一天的在籍狀態比對，預設今天；超出學期範圍會夾到學期內")
    parser.add_argument("--limit", type=int, default=20, help="每個分類最多列幾筆明細")
    args = parser.parse_args()

    album_db = open_readonly(args.db)
    upstream_db = open_readonly(args.upstream)
    album = load_album_state(album_db)
    semester = album["semester"]

    as_of = args.as_of or dt.date.today().isoformat()
    clamped = as_of
    if semester["ends_on"] and as_of > semester["ends_on"]:
        clamped = semester["ends_on"]
    if semester["starts_on"] and as_of < semester["starts_on"]:
        clamped = semester["starts_on"]

    upstream = load_upstream_state(upstream_db, semester["starts_on"], clamped)

    print(f"相本系統目前學期：{semester['label']}"
          f"（{semester['starts_on']} ~ {semester['ends_on']}）")
    print(f"行政系統對應學期：{upstream['semester']['name']}")
    if clamped != as_of:
        print(f"比對基準日：{clamped}（{as_of} 超出學期範圍，已夾到學期內）")
    else:
        print(f"比對基準日：{clamped}")
    print(f"上游快照：{args.upstream}")
    print()

    result = diff(album, upstream)
    roster_size = len(album["members"])
    for title, rows in (("可自動套用", result["auto"]), ("需人工審核", result["review"])):
        print(f"=== {title}：{len(rows)} 筆 ===")
        if not rows:
            print("  （無）")
        buckets: dict[str, list[str]] = {}
        for kind, detail in rows:
            buckets.setdefault(kind, []).append(detail)
        for kind, details in buckets.items():
            print(f"  {kind}：{len(details)} 筆")
            for detail in details[:args.limit]:
                print(f"    - {detail}")
            if len(details) > args.limit:
                print(f"    …另有 {len(details) - args.limit} 筆")
        print()

    total = len(result["auto"]) + len(result["review"])
    ratio = (total / roster_size * 100) if roster_size else 0
    print(f"在籍名冊 {roster_size} 位；漂移 {total} 筆，約佔 {ratio:.1f}%")
    if ratio > 5:
        print("！超過契約定義的 5% 爆炸半徑上限——真的要同步之前必須先查清楚原因")
    print("（本報告唯讀，未寫入任何資料）")


if __name__ == "__main__":
    main()
