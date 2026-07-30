"""依「名冊學號對照表」統一校正姓名：名冊、相本快照，並退回受影響的已完成相本。

背景：相冊名冊與行政系統是同一群孩子，姓名有兩種落差——

    形近字打錯（王珂筑／王珂笳），以及舊資料把相本內的「完整姓名」存成稱呼
    （相本內「可蕎」、名冊「戴可蕎」）。

處理四件事：

    1. `roster_children.name`：改成行政系統的姓名（依對照表）
    2. `students.name`：同步成名冊姓名。這個欄位由 DB trigger
       `trg_students_freeze_class_backed_identity` 凍結，因為它是期別快照、
       不該被後來的異動改寫。但「當初就打錯字」不是改寫歷史而是修正錯誤，
       所以這裡在同一個 transaction 內卸下 trigger、改完立刻裝回去。
    3. `roster_children.album_name`：稱呼是從姓名去掉姓氏推導的，姓名錯了稱呼
       也錯，而稱呼才是實際印在相本上的字。判斷方式是「稱呼不再是姓名的一部分」，
       改完清掉相關 `students.output_filename` 讓輸出重算（與
       `_set_roster_child_album_name` 同一套失效方式）。
    4. 受影響且已標記完成的相本：退回完成狀態（與 reopen_project 相同語意，
       清 project.completed_at 與旗下全部 student.completed_at），讓老師能重新確認。

沒有稱呼可補的孩子不在這裡處理，見 `fill_missing_album_names.py`。

可重複執行：每一步都以「現況與目標的差異」為準，跑第二次會是 0 筆。

安全機制：預設 dry-run；--apply 才寫入，並先備份原值。

用法：
    python scripts/correct_roster_names.py --mapping "…/名冊學號對照_最終.csv"
    python scripts/correct_roster_names.py --mapping "…" --apply
    python scripts/correct_roster_names.py --mapping "…" --db /app/db/album_maker.db --apply
"""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT_DIR / "backend" / "album_maker.db"

sys.path.insert(0, str(ROOT_DIR / "backend"))
from services.roster_identity_service import normalize_child_name  # noqa: E402
from services.student_input_policy import normalize_student_name  # noqa: E402

TRAILING_MARKS = "*.．·・_-+#＊。 　"
FREEZE_TRIGGER = "trg_students_freeze_class_backed_identity"


def clean_admin_name(raw: str) -> str:
    text = unicodedata.normalize("NFKC", str(raw or ""))
    return "".join(text.split()).rstrip(TRAILING_MARKS)


def load_mapping(path: Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8-sig")
    header = raw.splitlines()[0]
    delimiter = "\t" if header.count("\t") > header.count(",") else ","
    return list(csv.DictReader(raw.splitlines(), delimiter=delimiter))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping", type=Path, required=True)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--out-dir", type=Path, default=None, help="報表輸出目錄")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    out_dir = args.out_dir or args.mapping.parent
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    # ── 1) 名冊姓名 ────────────────────────────────────────────────────────
    roster_changes = []
    for row in load_mapping(args.mapping):
        raw_id = (row.get("相冊名冊ID") or "").strip()
        admin_name = clean_admin_name(row.get("行政系統姓名"))
        if not raw_id or not admin_name:
            continue
        child = conn.execute(
            "select id, name, album_name from roster_children where id = ?", (int(raw_id),)
        ).fetchone()
        if child is None:
            continue
        target = normalize_child_name(normalize_student_name(admin_name))
        if target and target != child["name"]:
            roster_changes.append({
                "child_id": child["id"],
                "old": child["name"],
                "new": target,
                "album_name": child["album_name"],
                "campus": row.get("分校", ""),
                "clas": row.get("班級", ""),
            })

    renamed = {item["child_id"]: item["new"] for item in roster_changes}

    # ── 2) 相本快照姓名：同步成（改名後的）名冊姓名 ────────────────────────
    student_changes = []
    for row in conn.execute("""
        select s.id sid, s.name sname, s.roster_child_id rid,
               ch.name cname, ch.album_name calb,
               p.id pid, p.name pname, p.completed_at pdone, p.classroom_id
        from students s
        join roster_children ch on ch.id = s.roster_child_id
        join projects p on p.id = s.project_id
        where p.deleted_at is null
    """):
        target = renamed.get(row["rid"], row["cname"])
        if target and target != row["sname"]:
            student_changes.append({
                "student_id": row["sid"],
                "old": row["sname"],
                "new": target,
                "album_name": row["calb"],
                "project_id": row["pid"],
                "project_name": row["pname"],
                "was_completed": row["pdone"] is not None,
                "kind": "補完整姓名" if row["sname"] and row["sname"] in target else "錯字更正",
            })

    # ── 3) 相本稱呼：姓名改了，從舊姓名推導出來的稱呼也跟著錯 ──────────────
    # 稱呼才是實際印在相本上的字，所以這裡一起改；改完舊輸出要失效重算，
    # 語意與 _set_roster_child_album_name 相同。
    # 用現況判斷而不是靠 roster_changes：姓名可能在先前的執行就改好了，
    # 但稱呼還停留在舊姓名推導的版本。
    album_changes, album_manual = [], []
    for row in conn.execute("""
        select ch.id, ch.name, ch.album_name, cp.name campus, cl.name clas
        from roster_children ch
        left join class_roster_members m on m.roster_child_id = ch.id and m.ended_at is null
        left join classrooms cl on cl.id = m.classroom_id
        left join campuses cp on cp.id = cl.campus_id
        where ch.album_name is not null and ch.album_name <> ''
    """):
        album_name = row["album_name"]
        if album_name in row["name"]:
            continue  # 稱呼仍是姓名的一部分，沒問題
        name_len, album_len = len(row["name"]), len(album_name)
        record = {
            "child_id": row["id"], "name": row["name"], "album_old": album_name,
            "campus": row["campus"] or "", "clas": row["clas"] or "",
        }
        if name_len > album_len:
            # 全庫 427 個有效稱呼裡有 419 個是「姓名去掉姓氏」，所以保持稱呼
            # 長度、取姓名後綴是安全的推導
            album_changes.append({**record, "album_new": row["name"][name_len - album_len:]})
        else:
            album_manual.append(record)

    # ── 4) 需要退回的已完成相本 ────────────────────────────────────────────
    # 改姓名會讓渲染指紋失效，改稱呼更會改變印出來的字，兩者都要讓老師重新確認
    reopen_ids = {c["project_id"] for c in student_changes if c["was_completed"]}
    if album_changes:
        child_ids = [item["child_id"] for item in album_changes]
        marks = ",".join("?" * len(child_ids))
        reopen_ids |= {
            int(pid) for (pid,) in conn.execute(
                f"""select distinct p.id from projects p
                    join students s on s.project_id = p.id
                    where s.roster_child_id in ({marks})
                      and p.deleted_at is null and p.completed_at is not null""",
                child_ids,
            )
        }
    reopen_ids = sorted(reopen_ids)

    print(f"名冊姓名更正      {len(roster_changes)} 位")
    print(f"相本快照姓名同步  {len(student_changes)} 筆"
          f"（錯字 {sum(1 for c in student_changes if c['kind'] == '錯字更正')}、"
          f"補完整姓名 {sum(1 for c in student_changes if c['kind'] == '補完整姓名')}）")
    print(f"相本稱呼更正      {len(album_changes)} 位"
          + (f"（另有 {len(album_manual)} 位推導不出、需人工）" if album_manual else ""))
    for item in album_changes:
        print(f"    {item['campus']}／{item['clas']} 「{item['album_old']}」"
              f"→「{item['album_new']}」（姓名 {item['name']}）")
    for item in album_manual:
        print(f"    !! {item['campus']}／{item['clas']} 稱呼「{item['album_old']}」"
              f" 與姓名「{item['name']}」對不上，需人工決定")
    print(f"需退回完成的相本  {len(reopen_ids)} 本 {reopen_ids}")

    if not args.apply:
        print("\n（dry-run，未寫入。加 --apply 才會執行）")
    else:
        stamp = datetime.now().strftime("%Y%m%d%H%M%S")
        backup = out_dir / f"姓名校正前備份_{stamp}.csv"
        with open(backup, "w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.writer(handle)
            writer.writerow(["類型", "識別", "原值", "新值", "相本"])
            for item in roster_changes:
                writer.writerow(["名冊姓名", item["child_id"], item["old"], item["new"], ""])
            for item in student_changes:
                writer.writerow([
                    "相本內姓名", item["student_id"], item["old"], item["new"],
                    item["project_name"],
                ])
            for item in album_changes:
                writer.writerow([
                    "相本稱呼", item["child_id"], item["album_old"], item["album_new"], "",
                ])
            for pid in reopen_ids:
                writer.writerow(["退回完成", pid, "已完成", "未完成", ""])
        print(f"\n原值已備份：{backup}")

        cursor = conn.cursor()
        cursor.execute("BEGIN")
        try:
            trigger_sql = cursor.execute(
                "select sql from sqlite_master where type='trigger' and name=?",
                (FREEZE_TRIGGER,),
            ).fetchone()
            if trigger_sql is None:
                raise SystemExit(f"找不到 {FREEZE_TRIGGER}，中止以免破壞既有保護")
            # 期別快照的凍結是刻意的護欄，只在這個修正 transaction 內暫時卸下
            cursor.execute(f"DROP TRIGGER {FREEZE_TRIGGER}")
            cursor.executemany(
                "update roster_children set name = ? where id = ?",
                [(item["new"], item["child_id"]) for item in roster_changes],
            )
            cursor.executemany(
                "update students set name = ? where id = ?",
                [(item["new"], item["student_id"]) for item in student_changes],
            )
            if album_changes:
                cursor.executemany(
                    "update roster_children set album_name = ? where id = ?",
                    [(item["album_new"], item["child_id"]) for item in album_changes],
                )
                # 稱呼是印在相本上的字，改了既有輸出就過期：清 output_filename
                # 讓下次下載重新渲染（與服務層同一套失效方式）
                child_ids = [item["child_id"] for item in album_changes]
                marks = ",".join("?" * len(child_ids))
                cursor.execute(
                    f"""update students set output_filename = null
                        where roster_child_id in ({marks})
                          and project_id in (select id from projects where classroom_id is not null)""",
                    child_ids,
                )
            if reopen_ids:
                marks = ",".join("?" * len(reopen_ids))
                cursor.execute(
                    f"update projects set completed_at = null where id in ({marks})",
                    reopen_ids,
                )
                cursor.execute(
                    f"update students set completed_at = null where project_id in ({marks})",
                    reopen_ids,
                )
            cursor.execute(trigger_sql[0])  # 立刻裝回，不留在卸下狀態
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        print(f"已更新名冊 {len(roster_changes)} 位、相本快照 {len(student_changes)} 筆、"
              f"退回 {len(reopen_ids)} 本相本。")

    # ── 5) 三校分開的溝通名單 ──────────────────────────────────────────────
    # 只列真正改到名字的孩子。「補完整姓名」那類（相本內原本存稱呼、現在補上
    # 完整姓名）老師端看不出任何變化，列出來只是雜訊。
    previous = {}
    for backup_file in sorted(out_dir.glob("姓名校正前備份_*.csv")):
        for row in csv.DictReader(backup_file.read_text(encoding="utf-8-sig").splitlines()):
            if row.get("類型") == "名冊姓名":
                previous[int(row["識別"])] = (row["原值"], row["新值"])

    completed_projects = set(reopen_ids)
    rows_by_campus = {}
    tracked = {item["child_id"] for item in album_changes} | set(previous)
    for child_id in sorted(tracked):
        child = conn.execute(
            "select id, name, album_name from roster_children where id = ?", (child_id,)
        ).fetchone()
        if child is None:
            continue
        where = conn.execute("""
            select cp.name campus, cl.name clas from class_roster_members m
            join classrooms cl on cl.id = m.classroom_id
            join campuses cp on cp.id = cl.campus_id
            where m.roster_child_id = ? and m.ended_at is null limit 1
        """, (child_id,)).fetchone()
        albums = [
            row["name"] for row in conn.execute("""
                select distinct p.name from projects p
                join students s on s.project_id = p.id
                where s.roster_child_id = ? and p.deleted_at is null
            """, (child_id,))
        ]
        reopened = any(
            pid in completed_projects for (pid,) in conn.execute("""
                select distinct p.id from projects p join students s on s.project_id = p.id
                where s.roster_child_id = ? and p.deleted_at is null
            """, (child_id,))
        )
        album_fix = next((a for a in album_changes if a["child_id"] == child_id), None)
        old_name, new_name = previous.get(child_id, ("", child["name"]))
        rows_by_campus.setdefault(where["campus"] if where else "（無班級）", []).append([
            where["clas"] if where else "",
            old_name or child["name"],
            new_name,
            album_fix["album_old"] if album_fix else (child["album_name"] or ""),
            album_fix["album_new"] if album_fix else (child["album_name"] or ""),
            "、".join(sorted(albums)) or "（尚無相本）",
            "是" if reopened else "",
        ])

    print("\n三校名單（只含姓名／稱呼真正改動的孩子）：")
    for campus, rows in sorted(rows_by_campus.items()):
        safe = campus.replace("／", "_").replace("/", "_")
        path = out_dir / f"姓名校正_{safe}.csv"
        with open(path, "w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.writer(handle)
            writer.writerow([
                "班級", "原姓名", "更正後姓名", "原稱呼", "更正後稱呼",
                "相關相本", "相本已退回完成",
            ])
            writer.writerows(sorted(rows))
        print(f"  {campus:<10} {len(rows):>3} 位 → {path.name}")


if __name__ == "__main__":
    main()
