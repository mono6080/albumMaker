"""依人工審核過的對照清單，把重複的名冊項併回現役那一筆並刪除。

重複是怎麼來的：舊相本的學生會升格成園所名冊項；老師後來把那些建錯或重複的相本刪掉，
但刪相本不刪名冊項（孩子屬於園所，不屬於某本相本，這是刻意的）。之後正式建園所名冊時，
同一個孩子又被建了第二次。留下來的第一筆沒有學號、沒有班級紀錄、只掛在已刪除的相本上。

**為什麼要人工清單而不是自動比對**：早期版本用「同名且只有一位有學號」自動配對。那與
`data-model.md` 的「姓名不是可靠的鍵」直接衝突——同名不同人（一位在籍、一位早年離園）
會被靜默合併並刪除，而刪掉的那一筆再也救不回來。判斷「是不是同一個孩子」需要學號、
生日或班級歷程等外部證據，那是人的工作，不是這支腳本的。

清單格式（CSV，UTF-8）：

    舊名冊ID,現役名冊ID
    17,472
    18,473

`scripts/`（或任何地方）產生候選清單都可以，但送進來的必須是**看過的**。

為什麼是「先改指向再刪」而不是直接刪：那些相本多半還在復原期限內。若把
`project_students.roster_child_id` 清成 NULL 再刪，相本一旦被復原，裡面的學生就跟名冊
斷線變成孤兒。改指到現役那筆才是把原本就該指對的地方修正。

每一列在 apply 當下都會重驗，任何一條不成立就整批中止（不是跳過——清單是人給的，
對不上代表清單與資料庫已經不同步）：

    1. 兩筆都存在，且不是同一筆
    2. 舊的沒有學號、沒有任何班級紀錄
    3. 舊的沒有被任何「未刪除」的相本引用
    4. 舊的引用中沒有已歸班（class-backed）的相本——DB trigger 會擋下那種更新
    5. 改指向後不會在同一本相本內出現兩個學生指向同一個名冊項

安全機制：預設 dry-run；`--apply` 才寫入，且先備份原值。全程在單一 transaction 內，
驗收通過才 commit。可重複執行。

用法：
    python scripts/merge_duplicate_roster_students.py --plan 對照.csv --db backend/album_maker.db
    python scripts/merge_duplicate_roster_students.py --plan 對照.csv --db backend/album_maker.db --apply
"""
import argparse
import csv
import os
import pathlib
import sys
from datetime import datetime

ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
# 容器內 backend/ 被攤平到 /app，開發樹則在 repo/backend
IMPORT_ROOT = BACKEND_DIR if (BACKEND_DIR / "database.py").is_file() else ROOT_DIR

REQUIRED_COLUMNS = ("舊名冊ID", "現役名冊ID")


def load_plan(path: pathlib.Path) -> list[tuple[int, int]]:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    if not lines:
        raise SystemExit(f"對照清單是空的：{path}")
    reader = csv.DictReader(lines)
    missing = [name for name in REQUIRED_COLUMNS if name not in (reader.fieldnames or [])]
    if missing:
        raise SystemExit(f"清單缺少必要欄位 {missing}；實際欄位：{reader.fieldnames}")
    pairs: list[tuple[int, int]] = []
    seen: set[int] = set()
    for row in reader:
        old_raw = str(row.get("舊名冊ID") or "").strip()
        live_raw = str(row.get("現役名冊ID") or "").strip()
        if not old_raw or not live_raw:
            continue
        old_id, live_id = int(old_raw), int(live_raw)
        if old_id in seen:
            raise SystemExit(f"清單裡名冊 {old_id} 出現多次")
        seen.add(old_id)
        pairs.append((old_id, live_id))
    if not pairs:
        raise SystemExit(f"清單沒有任何資料列：{path}")
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=pathlib.Path, required=True,
                        help="人工審核過的 舊名冊ID,現役名冊ID 對照 CSV")
    # 必填：預設連線是相對路徑，從不同目錄執行會指到不同檔案甚至建出空資料庫
    parser.add_argument("--db", type=pathlib.Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--out-dir", type=pathlib.Path, default=None,
                        help="備份輸出目錄，預設與清單同目錄")
    args = parser.parse_args()

    if not args.db.is_file():
        raise SystemExit(f"找不到資料庫：{args.db}")
    os.environ["DATABASE_URL"] = f"sqlite:///{args.db.resolve().as_posix()}"
    sys.path.insert(0, str(IMPORT_ROOT))
    from database import (  # noqa: PLC0415  設好 DATABASE_URL 之後才能 import
        ClassroomMember,
        Project,
        ProjectStudent,
        SessionLocal,
        Student,
    )

    pairs = load_plan(args.plan)
    out_dir = args.out_dir or args.plan.parent

    db = SessionLocal()
    try:
        # BEGIN IMMEDIATE：檢查與寫入之間不讓別人插隊，否則 survey 之後新增的引用
        # 會被 bulk update 掃到，卻不在備份與預期集合裡。
        db.execute_options = None
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")

        problems: list[str] = []
        merges = []
        for old_id, live_id in pairs:
            old_child = db.get(Student, old_id)
            live_child = db.get(Student, live_id)
            if old_child is None or live_child is None:
                problems.append(f"名冊 {old_id}→{live_id}：其中一筆不存在")
                continue
            if old_id == live_id:
                problems.append(f"名冊 {old_id}：來源與目標相同")
                continue
            if old_child.student_serial:
                problems.append(f"名冊 {old_id}「{old_child.name}」已有學號，不該被併掉")
                continue
            if db.query(ClassroomMember.id).filter(
                ClassroomMember.roster_child_id == old_id
            ).count():
                problems.append(f"名冊 {old_id}「{old_child.name}」仍有班級紀錄")
                continue

            references = db.query(ProjectStudent, Project).join(
                Project, Project.id == ProjectStudent.project_id
            ).filter(ProjectStudent.roster_child_id == old_id).all()
            if any(project.deleted_at is None for _, project in references):
                problems.append(f"名冊 {old_id}「{old_child.name}」仍被未刪除的相本引用")
                continue
            # 已歸班的相本即使被軟刪，DB trigger 仍會擋下 roster_child_id 的更新；
            # 先擋在這裡，不要跑到一半才炸。
            class_backed = [
                project.id for _, project in references if project.classroom_id is not None
            ]
            if class_backed:
                problems.append(
                    f"名冊 {old_id}「{old_child.name}」被已歸班相本 {class_backed} 引用，"
                    "DB trigger 不允許改指向"
                )
                continue
            collision = [
                student.project_id
                for student, _ in references
                if db.query(ProjectStudent.id).filter(
                    ProjectStudent.project_id == student.project_id,
                    ProjectStudent.roster_child_id == live_id,
                ).count()
            ]
            if collision:
                problems.append(
                    f"名冊 {old_id}「{old_child.name}」：相本 {collision} 內已有指向 {live_id} 的學生"
                )
                continue
            merges.append((old_child, live_child, [student for student, _ in references]))

        print(f"清單 {len(pairs)} 筆")
        print(f"  可合併 {len(merges)}"
              f"（要改指向的 project_students 共 {sum(len(r) for _, _, r in merges)} 列）")
        print(f"  有問題 {len(problems)}")
        for line in problems[:20]:
            print(f"      {line}")

        for old_child, live_child, references in merges:
            note = ""
            if old_child.album_name and old_child.album_name != live_child.album_name:
                note = f"  ⚠ 稱呼不同：舊「{old_child.album_name}」現役「{live_child.album_name}」"
            print(f"    刪 {old_child.id:>4}「{old_child.name}」→ 併入 {live_child.id}"
                  f"（{live_child.student_serial}）改 {len(references)} 列{note}")

        if problems:
            print("\n清單與資料庫不一致，整批中止——清單是人審核過的，對不上代表狀態已改變。")
            db.rollback()
            return 1
        if not args.apply:
            print("\n（dry-run，未寫入。加 --apply 才會執行）")
            db.rollback()
            return 0
        if not merges:
            print("\n沒有可合併的項目。")
            db.rollback()
            return 0

        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d%H%M%S")
        backup = out_dir / f"名冊重複項合併前備份_{stamp}.csv"
        with open(backup, "w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.writer(handle)
            writer.writerow([
                "類型", "舊名冊ID", "姓名", "舊稱呼",
                "現役名冊ID", "現役學號", "project_student_id", "相本ID",
            ])
            for old_child, live_child, references in merges:
                for student in references:
                    writer.writerow([
                        "改指向", old_child.id, old_child.name, old_child.album_name,
                        live_child.id, live_child.student_serial,
                        student.id, student.project_id,
                    ])
                writer.writerow([
                    "刪除名冊項", old_child.id, old_child.name, old_child.album_name,
                    live_child.id, live_child.student_serial, "", "",
                ])
        print(f"\n原值已備份：{backup}")

        # 先把指向全部改完並 flush，再刪。順序反過來的話，SQLAlchemy 刪除父列時會依
        # relationship 預設把子列的 FK 清成 NULL，把剛改好的指向蓋掉——而且不會報錯。
        expected = {
            student.id: live_child.id
            for _, live_child, references in merges
            for student in references
        }
        for old_child, live_child, _ in merges:
            db.query(ProjectStudent).filter(
                ProjectStudent.roster_child_id == old_child.id
            ).update(
                {ProjectStudent.roster_child_id: live_child.id},
                synchronize_session=False,
            )
        db.flush()
        db.expire_all()
        for old_child, _, _ in merges:
            db.delete(db.get(Student, old_child.id))
        db.flush()

        # 驗收在 commit 之前：這次失敗還能整批 rollback
        wrong = [
            (student_id, live_id, actual)
            for student_id, live_id in expected.items()
            for (actual,) in [
                db.query(ProjectStudent.roster_child_id)
                .filter(ProjectStudent.id == student_id)
                .one()
            ]
            if actual != live_id
        ]
        remaining = db.query(Student.id).filter(
            Student.id.in_([old_child.id for old_child, _, _ in merges])
        ).count()
        if wrong or remaining:
            db.rollback()
            print(f"\n驗收失敗，已全部回復：指向錯誤 {len(wrong)} 列、"
                  f"未刪除 {remaining} 筆")
            return 1

        db.commit()
        print(f"已改指向 {len(expected)} 列、刪除 {len(merges)} 個重複名冊項。")
        print(f"名冊剩 {db.query(Student).count()} 位；驗收通過。")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
