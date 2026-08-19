"""依人工核對過的對照表，把行政系統學號回填進名冊。

為什麼要學號：與行政系統對帳時，姓名不是可靠的鍵——2026-08 就更正過 31 筆打錯的
姓名、28 筆跟著錯的稱呼。學號在行政系統內唯一且不變，對起來沒有灰色地帶。

對照表哪裡來：`名冊學號對照_最終.csv`，欄位至少要有 `相冊名冊ID` 與 `學號`。
那份表是姓名更正那一輪產出的，每一列都經過人工核對（姓名完全相同 430、人工確認 26、
正規化後相同 7、同班唯一剩餘且姓名相近 2）。這支腳本只做回填，不重新比對。

已經有學號且值相同的跳過；值不同的**不覆寫**，列出來讓人決定——學號改變代表行政系統
那邊換了身分，不是這支腳本該自己決定的事。

用法（預設 dry-run，--apply 才寫入）：

    python scripts/backfill_student_serials.py --mapping "…/名冊學號對照_最終.csv" --db backend/album_maker.db
    python scripts/backfill_student_serials.py --mapping "…" --db backend/album_maker.db --apply
"""
import argparse
import csv
import os
import pathlib
import sys

ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
# 容器內 backend/ 被攤平到 /app，開發樹則在 repo/backend
IMPORT_ROOT = BACKEND_DIR if (BACKEND_DIR / "database.py").is_file() else ROOT_DIR

REQUIRED_COLUMNS = ("相冊名冊ID", "學號")


def load_mapping(path: pathlib.Path) -> list[dict]:
    raw = path.read_text(encoding="utf-8-sig")
    lines = raw.splitlines()
    if not lines:
        raise SystemExit(f"對照表是空的：{path}")
    header = lines[0]
    delimiter = "\t" if header.count("\t") > header.count(",") else ","
    reader = csv.DictReader(lines, delimiter=delimiter)
    missing = [name for name in REQUIRED_COLUMNS if name not in (reader.fieldnames or [])]
    if missing:
        # 欄名打錯時不能靜靜地回報「0 筆可回填」——那看起來像成功
        raise SystemExit(
            f"對照表缺少必要欄位 {missing}；實際欄位：{reader.fieldnames}"
        )
    rows = list(reader)
    if not rows:
        raise SystemExit(f"對照表沒有任何資料列：{path}")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping", type=pathlib.Path, required=True)
    # 必填：database.py 的預設連線是相對路徑，從不同目錄執行會指到不同檔案，
    # 甚至建出一個空的新資料庫還印「初始 admin 帳號已建立」。
    parser.add_argument("--db", type=pathlib.Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    if not args.db.is_file():
        raise SystemExit(f"找不到資料庫：{args.db}")
    os.environ["DATABASE_URL"] = f"sqlite:///{args.db.resolve().as_posix()}"
    sys.path.insert(0, str(IMPORT_ROOT))
    from database import SessionLocal, Student  # noqa: PLC0415  設好 DATABASE_URL 之後才能 import

    pairs: dict[int, str] = {}
    conflicts: list[str] = []
    seen_serials: dict[str, int] = {}
    for row in load_mapping(args.mapping):
        raw_id = str(row.get("相冊名冊ID") or "").strip()
        serial = str(row.get("學號") or "").strip()
        if not raw_id or not serial:
            continue
        child_id = int(raw_id)
        # 同一個孩子被列了兩個不同學號，或同一個學號被列給兩個孩子：
        # 兩種都代表對照表本身有問題，不能靠「後面蓋前面」自己挑一個。
        if child_id in pairs and pairs[child_id] != serial:
            conflicts.append(f"名冊 {child_id} 對到 {pairs[child_id]} 與 {serial}")
        if serial in seen_serials and seen_serials[serial] != child_id:
            conflicts.append(f"學號 {serial} 對到名冊 {seen_serials[serial]} 與 {child_id}")
        seen_serials[serial] = child_id
        pairs[child_id] = serial

    if conflicts:
        print(f"對照表自相矛盾 {len(conflicts)} 筆，中止：")
        for line in conflicts[:10]:
            print(f"    {line}")
        return 1

    db = SessionLocal()
    try:
        to_fill, already, skipped_conflicts, missing = [], [], [], []
        taken = {
            serial: child_id
            for child_id, serial in db.query(Student.id, Student.student_serial)
            .filter(Student.student_serial.isnot(None))
        }
        for child_id, serial in sorted(pairs.items()):
            child = db.get(Student, child_id)
            if child is None:
                missing.append((child_id, serial))
            elif child.student_serial == serial:
                already.append(child_id)
            elif child.student_serial:
                skipped_conflicts.append((child_id, child.name, child.student_serial, serial))
            elif serial in taken and taken[serial] != child_id:
                skipped_conflicts.append((child_id, child.name, f"(學號已屬名冊 {taken[serial]})", serial))
            else:
                to_fill.append((child, serial))

        print(f"對照表 {len(pairs)} 筆")
        print(f"  可回填      {len(to_fill)}")
        print(f"  已經一致    {len(already)}")
        print(f"  名冊查無此人 {len(missing)}")
        print(f"  衝突不覆寫  {len(skipped_conflicts)}")
        for child_id, name, old, new in skipped_conflicts:
            print(f"      名冊 {child_id}「{name}」現有 {old} → 對照表 {new}")
        for child_id, serial in missing[:10]:
            print(f"      名冊 {child_id}（學號 {serial}）不存在")

        if not args.apply:
            print("\n（dry-run，未寫入。加 --apply 才會執行）")
            return 1 if skipped_conflicts or missing else 0

        # 條件式 UPDATE：讀取現值到寫入之間若有人先填了，這裡就不會蓋掉他
        written = 0
        for child, serial in to_fill:
            written += db.query(Student).filter(
                Student.id == child.id,
                Student.student_serial.is_(None),
            ).update({Student.student_serial: serial}, synchronize_session=False)
        db.commit()
        if written != len(to_fill):
            print(f"警告：預期寫入 {len(to_fill)} 筆，實際 {written} 筆——"
                  "期間有其他寫入，請重跑確認結果")
        print(f"\n已回填 {written} 位。")
        total = db.query(Student).count()
        with_serial = db.query(Student).filter(Student.student_serial.isnot(None)).count()
        print(f"名冊 {total} 位，其中 {with_serial} 位有學號。")
        return 1 if skipped_conflicts or missing else 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
