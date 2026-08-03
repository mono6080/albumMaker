"""在正式資料副本上跑完升級，然後以真實帳號掃過每一條 GET。

migration 跑完不代表 app 讀得動——schema 對了，但序列化、權限判斷與報表都還沒碰過
正式資料的形狀。這支腳本補的就是那一段：複製一份升級前的正式資料 → 走完整 lifespan
（表改名 → `init_db()` → `run_migrations()`）→ 以 admin 與一位真實在職老師的身分打過
每一條 GET，任何 5xx 都算失敗。

不用 pytest 指向正式資料：測試的斷言是對著 conftest 建出的隔離資料庫寫的，換成正式
資料只會得到一堆與程式碼無關的失敗。

用法（**只對副本執行**，它會寫入 target）：

    python scripts/smoke_upgraded_production_copy.py
        --source backend/album_maker.db.bak-pre-rename-20260731
        --target /tmp/smoke.db

（上面三行是同一道指令，換行只為了排版）
"""
import argparse
import os
import pathlib
import shutil
import sys

ROOT_DIR = pathlib.Path(__file__).resolve().parents[1]

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=pathlib.Path, required=True, help="升級前的正式資料")
parser.add_argument("--target", type=pathlib.Path, required=True, help="副本落點，會被覆寫")
args = parser.parse_args()

if args.source.resolve() == args.target.resolve():
    raise SystemExit("target 不能等於 source——這支腳本會寫入 target")

# WAL 模式下 -wal／-shm 與主檔是一組，複製時要一起帶走
for suffix in ("", "-wal", "-shm"):
    source = args.source.with_name(args.source.name + suffix)
    target = args.target.with_name(args.target.name + suffix)
    target.unlink(missing_ok=True)
    if source.exists():
        shutil.copy2(source, target)

# database.py 在 import 時就建立 engine，環境變數必須早於 import
os.environ["DATABASE_URL"] = f"sqlite:///{args.target.resolve().as_posix()}"
os.environ.setdefault("RENDER_RECONCILE_ON_STARTUP", "0")
sys.path.insert(0, str(ROOT_DIR / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from auth import hash_password  # noqa: E402
from database import (  # noqa: E402
    Classroom,
    ClassroomTeacher,
    Project,
    SessionLocal,
    Template,
    User,
)
from main import app  # noqa: E402

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(label)


def server_errors(client, paths) -> list[str]:
    """只看 5xx：4xx 是權限與參數判斷，本來就該因身分而異。"""
    return [
        f"{path} → {response.status_code} {response.text[:120]}"
        for path, response in ((path, client.get(path)) for path in paths)
        if response.status_code >= 500
    ]


with TestClient(app) as client:
    # 走到這裡代表改名與 migration 在正式資料上跑完了
    print("1) 升級後啟動")
    check("health 200", client.get("/api/health").status_code == 200)

    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.role == "admin").order_by(User.id).first()
        assignment = (
            db.query(ClassroomTeacher)
            .filter(
                ClassroomTeacher.ended_at.is_(None),
                ClassroomTeacher.teacher_id.isnot(None),
            )
            .order_by(ClassroomTeacher.id)
            .first()
        )
        if admin is None or assignment is None:
            raise SystemExit("副本裡找不到 admin 或在職老師，這不是正式資料")
        teacher = db.get(User, assignment.teacher_id)
        # 只改副本的密碼，用真實帳號才能驗到真實的權限判斷
        admin.hashed_password = hash_password("smoke-admin")
        teacher.hashed_password = hash_password("smoke-teacher")
        admin_username, teacher_username = admin.username, teacher.username
        db.commit()
        project_ids = [
            row[0]
            for row in db.query(Project.id)
            .filter(Project.deleted_at.is_(None))
            .order_by(Project.id)
            .limit(5)
        ]
        template_ids = [
            row[0] for row in db.query(Template.id).order_by(Template.id).limit(5)
        ]
        classroom_total = db.query(Classroom.id).count()
        print(f"   admin={admin_username} teacher={teacher_username} "
              f"相本={len(project_ids)} 模板={len(template_ids)} 班總數={classroom_total}")
    finally:
        db.close()

    plain_gets = sorted({
        route.path
        for route in app.routes
        if "GET" in getattr(route, "methods", set())
        and route.path.startswith("/api/")
        and "{" not in route.path
    })
    detail_paths = [
        f"/api/projects/{project_id}{suffix}"
        for project_id in project_ids
        for suffix in ("", "/label_texts", "/comments", "/assignment-history")
    ] + [f"/api/templates/{template_id}" for template_id in template_ids]

    for role, username, password in (
        ("admin", admin_username, "smoke-admin"),
        ("teacher", teacher_username, "smoke-teacher"),
    ):
        print(f"\n2) {role} 讀取路徑")
        client.cookies.clear()
        login = client.post(
            "/api/auth/login", data={"username": username, "password": password}
        )
        check(f"{role} 可登入", login.status_code == 200, login.text[:120])
        if login.status_code != 200:
            continue
        plain_errors = server_errors(client, plain_gets)
        check(f"{role} 無參數 GET 無 5xx（{len(plain_gets)} 條）",
              not plain_errors, "; ".join(plain_errors[:3]))
        detail_errors = server_errors(client, detail_paths)
        check(f"{role} 明細路徑無 5xx（{len(detail_paths)} 條）",
              not detail_errors, "; ".join(detail_errors[:3]))

    print("\n3) 升級後的資料形狀")
    client.cookies.clear()
    client.post(
        "/api/auth/login", data={"username": admin_username, "password": "smoke-admin"}
    )
    overview = client.get("/api/organization/overview")
    check("園所總覽 200", overview.status_code == 200, overview.text[:120])
    if overview.status_code == 200:
        rooms = [
            room
            for campus in overview.json()["campuses"]
            for room in campus["classrooms"]
        ]
        # 班不跨學期，同一個班名不過濾就會以「本學期」與「已結束」出現兩次
        check("班級沒有重複列出", len(rooms) == len({room["id"] for room in rooms}),
              f"{len(rooms)} 筆")
        missing_semester = [room["id"] for room in rooms if not room.get("semester_id")]
        check("每個班都掛在學期上", not missing_semester, f"缺學期：{missing_semester[:5]}")
        members = [member for room in rooms for member in room["members"]]
        active = [member for member in members if member.get("ended_at") is None]
        check("目前學期有在籍名冊", bool(active),
              f"在籍 {len(active)} 筆 / 全部 {len(members)} 筆")

    semesters = client.get("/api/organization/semesters")
    check("學期清單 200", semesters.status_code == 200, semesters.text[:120])
    if semesters.status_code == 200:
        rows = semesters.json()
        current = next((row for row in rows if row.get("is_current")), None)
        check("剛好一個目前學期",
              len([row for row in rows if row.get("is_current")]) == 1,
              f"狀態：{[row['status'] for row in rows]}")
        if current is not None:
            progress = client.get(
                "/api/roster/teacher-progress", params={"semester_id": current["id"]}
            )
            check("老師進度 200", progress.status_code == 200, progress.text[:200])

print()
if failures:
    print(f"=== {len(failures)} 項失敗 ===")
    for label in failures:
        print(f"  - {label}")
    sys.exit(1)
print("=== 全部通過 ===")
