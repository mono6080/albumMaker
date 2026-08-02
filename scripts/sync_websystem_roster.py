"""依行政系統把名冊與編班同步過來。**預設 dry-run，`--apply` 才寫入。**

分類與四道安全閘的理由見 `docs/specs/websystem-roster-sync-v1.md`。這支只做「上游說了算」
的那一類；會改變權限或撞上已知死結的，一律只列出來給人處理，不自己決定。

自動套用：
  - 新生建檔並編入班級（名冊沒有這個學號）
  - 已在名冊但沒有在班區間 → 補上
  - 姓名更正
  - 離園（**但該生若有製作中相本則不動**，改列待審）

只列出、不套用：
  - 期中換班（相本歸屬要在匯出時裁決，見 academic-term-reporting-v1）
  - 老師編制異動（`classroom_teachers` 同時決定四處權限行為）
  - 班級增減

用法：

    python scripts/sync_websystem_roster.py --upstream <快照.db> --db backend/album_maker.db
    python scripts/sync_websystem_roster.py --upstream ... --db ... --apply
"""
import argparse
import datetime as dt
import pathlib
import sqlite3
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[0]))

from report_websystem_drift import (  # noqa: E402
    diff,
    load_album_state,
    load_upstream_state,
    normalize_name,
    open_readonly,
)

# 單次同步最多能動名冊的幾成。超過就整批中止——防的是上游快照損壞或對應鍵大量失效
# 把名冊洗掉，那種錯不會報錯，只會安靜地把資料改成別的樣子。
BLAST_RADIUS_RATIO = 0.05

AUTO_KINDS = {
    "名冊：新生應建檔並入班",
    "名冊：應入班",
    "名冊：姓名不符",
    "名冊：應離園",
}


def blast_radius_error(auto_count: int, roster_size: int) -> str | None:
    """超過上限就回傳中止訊息。分開成函式是為了測得到——這道閘門擋的是
    「上游快照壞掉把名冊洗掉」，那種錯不會報錯，只會安靜地把資料改成別的樣子。"""
    if roster_size <= 0:
        return "在籍名冊是空的，無法判斷變更幅度"
    ratio = auto_count / roster_size
    if ratio <= BLAST_RADIUS_RATIO:
        return None
    return (
        f"！自動套用 {auto_count} 筆佔在籍名冊 {ratio * 100:.1f}%，"
        f"超過 {BLAST_RADIUS_RATIO * 100:.0f}% 上限——整批中止。"
        "先確認上游快照與對應鍵是不是出了問題。"
    )


def _current_semester_id(db: sqlite3.Connection) -> int:
    row = db.execute("select id from semesters where status = 'imported'").fetchone()
    if row is None:
        sys.exit("相本系統沒有 imported 學期")
    return int(row[0])


def _classroom_id(db: sqlite3.Connection, semester_id: int, campus: str, room: str) -> int | None:
    row = db.execute(
        """
        select cr.id from classrooms cr join campuses cp on cp.id = cr.campus_id
         where cr.semester_id = ? and cp.name = ? and cr.name = ?
        """,
        (semester_id, campus, room),
    ).fetchone()
    return int(row[0]) if row else None


def apply_changes(
    db: sqlite3.Connection,
    album: dict,
    upstream: dict,
    plan: dict,
    *,
    snapshot_label: str,
) -> list[str]:
    """套用自動類別。呼叫端負責 commit／rollback。"""
    semester_id = int(album["semester"]["id"])
    now = dt.datetime.now(dt.timezone.utc).isoformat(sep=" ", timespec="microseconds")
    log: list[str] = []

    auto_kinds = {kind for kind, _ in plan["auto"]}
    if not auto_kinds:
        return log

    # 姓名更正：以學號定位，改的是名冊項本身
    for serial, up_member in upstream["members"].items():
        here = album["members"].get(serial)
        if here is None:
            continue
        if normalize_name(here["name"]) == normalize_name(up_member["name"]):
            continue
        clean = normalize_name(up_member["name"])
        db.execute("update students set name = ? where id = ?", (clean, here["student_id"]))
        log.append(f"改名 {serial} 「{here['name']}」→「{clean}」")

    # 入班：名冊沒有的先建檔，再補在班區間
    for serial, up_member in upstream["members"].items():
        if serial in album["members"]:
            continue
        classroom_id = _classroom_id(db, semester_id, up_member["campus"], up_member["room"])
        if classroom_id is None:
            log.append(f"！跳過 {serial}：相本系統沒有 {up_member['campus']}／{up_member['room']}")
            continue
        known = album["serials"].get(serial)
        if known is None:
            clean = normalize_name(up_member["name"])
            cursor = db.execute(
                "insert into students (name, student_serial, created_at) values (?, ?, ?)",
                (clean, serial, now),
            )
            roster_child_id = int(cursor.lastrowid)
            log.append(f"新生建檔 {clean}（{serial}）")
        else:
            roster_child_id = int(known["id"])
        db.execute(
            "insert into classroom_members (classroom_id, roster_child_id, started_at)"
            " values (?, ?, ?)",
            (classroom_id, roster_child_id, now),
        )
        log.append(f"入班 {serial} → {up_member['campus']}／{up_member['room']}")

    # 離園：只動「上游已不在籍且沒有製作中相本」的那些
    in_progress = album.get("in_progress", set())
    for serial, here in album["members"].items():
        if serial in upstream["members"] or serial in in_progress:
            continue
        db.execute(
            "update classroom_members set ended_at = ?, end_reason = 'departed' where id = ?",
            (now, here["member_id"]),
        )
        log.append(f"離園 {serial}（{here['name']}）")

    log.append(f"依據上游快照：{snapshot_label}")
    return log


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=pathlib.Path, required=True)
    parser.add_argument("--db", type=pathlib.Path, required=True)
    parser.add_argument("--as-of", default=None)
    parser.add_argument("--apply", action="store_true", help="真的寫入；省略則只預覽")
    args = parser.parse_args()

    album_ro = open_readonly(args.db)
    upstream_db = open_readonly(args.upstream)
    album = load_album_state(album_ro)
    semester = album["semester"]

    as_of = args.as_of or dt.date.today().isoformat()
    if semester["ends_on"] and as_of > semester["ends_on"]:
        as_of = semester["ends_on"]
    if semester["starts_on"] and as_of < semester["starts_on"]:
        as_of = semester["starts_on"]
    upstream = load_upstream_state(upstream_db, semester["starts_on"], as_of)
    plan = diff(album, upstream)

    roster_size = len(album["members"]) or 1
    auto = [row for row in plan["auto"] if row[0] in AUTO_KINDS]
    unknown = [row for row in plan["auto"] if row[0] not in AUTO_KINDS]
    review = plan["review"] + unknown

    print(f"學期 {semester['label']}；基準日 {as_of}；上游快照 {args.upstream}")
    print(f"自動套用 {len(auto)} 筆、需人工處理 {len(review)} 筆（在籍 {len(album['members'])} 位）")
    print()
    for title, rows in (("將自動套用", auto), ("需人工處理（本腳本不動）", review)):
        print(f"=== {title} ===")
        if not rows:
            print("  （無）")
        for kind, detail in rows:
            print(f"  [{kind}] {detail}")
        print()

    blocked = blast_radius_error(len(auto), roster_size)
    if blocked:
        sys.exit(blocked)

    if not args.apply:
        print("（dry-run，未寫入。加 --apply 才執行）")
        return
    if not auto:
        print("沒有要自動套用的項目。")
        return

    connection = sqlite3.connect(args.db)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        connection.execute("BEGIN IMMEDIATE")
        log = apply_changes(
            connection, album, upstream, {"auto": auto},
            snapshot_label=str(args.upstream),
        )
        # 只寫目前學期：碰到已結束學期代表分類或對應出錯，freeze trigger 也會擋
        stray = connection.execute(
            """
            select count(*) from classroom_members m
              join classrooms cr on cr.id = m.classroom_id
             where cr.semester_id != ? and m.started_at >= ?
            """,
            (semester["id"], dt.date.today().isoformat()),
        ).fetchone()[0]
        if stray:
            raise RuntimeError(f"寫到了非目前學期的班級（{stray} 筆），已回滾")
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    print("=== 已套用 ===")
    for line in log:
        print("  " + line)


if __name__ == "__main__":
    main()
