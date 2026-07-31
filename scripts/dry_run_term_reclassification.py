"""在正式資料副本上實際跑一次新學期編班，並逐項驗證結果。

編班套用會關閉舊學期、結束全部名冊與編制、在新學期建立對應的班與工作格——
上線當天一定會做，而且做錯無法回頭。這支腳本讓那一步先在副本上跑過一次。

用法（**只對副本執行**，它會真的寫入）：

    cp backend/album_maker.db /tmp/dryrun.db
    DATABASE_URL="sqlite:////tmp/dryrun.db"     ALBUM_MAKER_UPLOADS_DIR=/tmp/dryrun_uploads     python scripts/dry_run_term_reclassification.py

驗的是：草稿涵蓋全部班級與在籍學生、套用後舊學期清空而新學期承接、相本快照與
學生名單一個位元都沒動、每個新班都有工作格、老師對舊相本可讀不可製作、
以及沒有殘留的在職編制擋住下一次編班。
"""
import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "backend"))

from fastapi.testclient import TestClient  # noqa: E402

from auth import hash_password  # noqa: E402
from database import (  # noqa: E402
    Classroom,
    ClassroomMember,
    ClassroomTeacher,
    Project,
    ProjectStudent,
    SessionLocal,
    Semester,
    User,
)
from main import app  # noqa: E402


def snapshot_projects(db):
    """相本的組織快照與學生名單——套用編班絕不能改動它們。"""
    return {
        project.id: {
            "name": project.name,
            "campus_id_snapshot": project.campus_id_snapshot,
            "campus_name_snapshot": project.campus_name_snapshot,
            "classroom_name_snapshot": project.classroom_name_snapshot,
            "department": project.department,
            "classroom_id": project.classroom_id,
            "work_slot_id": project.class_period_work_slot_id,
            "owner_id": project.owner_id,
            "students": sorted(
                (student.id, student.name, student.roster_child_id)
                for student in project.students
            ),
        }
        for project in db.query(Project).all()
    }


def counts(db, semester_id):
    return {
        "classrooms": db.query(Classroom).filter(
            Classroom.semester_id == semester_id
        ).count(),
        "active_members": db.query(ClassroomMember)
        .join(Classroom, Classroom.id == ClassroomMember.classroom_id)
        .filter(
            Classroom.semester_id == semester_id,
            ClassroomMember.ended_at.is_(None),
        )
        .count(),
        "active_teachers": db.query(ClassroomTeacher)
        .join(Classroom, Classroom.id == ClassroomTeacher.classroom_id)
        .filter(
            Classroom.semester_id == semester_id,
            ClassroomTeacher.ended_at.is_(None),
        )
        .count(),
    }


failures = []


def check(label, condition, detail=""):
    mark = "OK  " if condition else "FAIL"
    print(f"  [{mark}] {label}{(' — ' + detail) if detail else ''}")
    if not condition:
        failures.append(label)


db = SessionLocal()
try:
    if db.query(User).filter(User.username == "dryrun_admin").first() is None:
        db.add(User(
            username="dryrun_admin",
            display_name="演練管理員",
            hashed_password=hash_password("dryrun-pass"),
            role="admin",
        ))
        db.commit()
    source_semester = db.query(Semester).filter(Semester.status == "imported").one()
    source_semester_id = source_semester.id
    before_projects = snapshot_projects(db)
    before_counts = counts(db, source_semester_id)
    # 取一位帶班老師，之後驗證他的相本權限怎麼變
    sample_assignment = (
        db.query(ClassroomTeacher)
        .join(Classroom, Classroom.id == ClassroomTeacher.classroom_id)
        .filter(
            Classroom.semester_id == source_semester_id,
            ClassroomTeacher.ended_at.is_(None),
            ClassroomTeacher.teacher_id.isnot(None),
        )
        .first()
    )
    sample_teacher_id = sample_assignment.teacher_id
    sample_classroom_id = sample_assignment.classroom_id
    sample_project = (
        db.query(Project)
        .filter(
            Project.classroom_id == sample_classroom_id,
            Project.deleted_at.is_(None),
        )
        .first()
    )
    sample_project_id = sample_project.id if sample_project else None
    sample_teacher = db.get(User, sample_teacher_id)
    sample_teacher.hashed_password = hash_password("dryrun-teacher")
    sample_teacher_username = sample_teacher.username
    db.commit()
finally:
    db.close()

print(f"套用前：{before_counts}，相本 {len(before_projects)} 本")
print(f"取樣老師 id={sample_teacher_id} 班級 id={sample_classroom_id} 相本 id={sample_project_id}")
print()

client = TestClient(app)
login = client.post(
    "/api/auth/login",
    data={"username": "dryrun_admin", "password": "dryrun-pass"},
)
assert login.status_code == 200, login.text

print("1) 建立編班草稿")
plan_response = client.post(
    "/api/organization/term-reclassification-plans",
    json={"label": "演練：下學期"},
)
assert plan_response.status_code == 201, plan_response.text
plan = plan_response.json()
target_semester_id = plan["target_semester_id"]
check(
    "草稿涵蓋全部 38 個班",
    len(plan["target_classrooms"]) == before_counts["classrooms"],
    f"{len(plan['target_classrooms'])} 個",
)
check(
    "每位在籍學生都有 placement",
    len(plan["student_placements"]) == before_counts["active_members"],
    f"{len(plan['student_placements'])} 筆",
)
check(
    "預設全部留在原班",
    all(row["keeps_source_classroom"] for row in plan["student_placements"]),
)
check(
    "diff 的留班數等於在籍人數",
    len(plan["diff"]["students"]["stay"]) == before_counts["active_members"],
    f"stay={len(plan['diff']['students']['stay'])} move={len(plan['diff']['students']['move'])}",
)
check(
    "老師 diff 全空（沿用目前編制）",
    not plan["diff"]["teachers"]["add"]
    and not plan["diff"]["teachers"]["remove"]
    and not plan["diff"]["teachers"]["duty_change"],
)

print()
print("2) 建立新學期期別")
created_period_ids = []
for department, name in (("infant", "演練期別-嬰幼"), ("academy", "演練期別-學院")):
    period_response = client.post(
        "/api/templates/periods",
        data={
            "name": name,
            "department": department,
            "status": "active",
            "semester_id": str(target_semester_id),
        },
    )
    assert period_response.status_code == 200, period_response.text
    created_period_ids.append(period_response.json()["id"])
refreshed = client.get(
    f"/api/organization/term-reclassification-plans/{plan['id']}"
).json()
check(
    "新期別自動歸入目標學期",
    len(refreshed["target_semester"]["periods"]) == len(created_period_ids),
    f"{len(refreshed['target_semester']['periods'])} 個",
)
check("驗證通過", refreshed["validation"]["is_valid"], json.dumps(
    refreshed["validation"]["errors"], ensure_ascii=False,
))

print()
print("3) 套用")
apply_response = client.post(
    f"/api/organization/term-reclassification-plans/{plan['id']}/apply",
    json={"expected_revision": refreshed["revision"]},
)
check("套用回 200", apply_response.status_code == 200, apply_response.text[:200])
if apply_response.status_code != 200:
    sys.exit(1)

print()
print("4) 資料驗證")
db = SessionLocal()
try:
    after_source = counts(db, source_semester_id)
    after_target = counts(db, target_semester_id)
    check(
        "舊學期不再有在籍學生",
        after_source["active_members"] == 0,
        f"{after_source['active_members']} 筆",
    )
    check(
        "舊學期不再有在職編制",
        after_source["active_teachers"] == 0,
        f"{after_source['active_teachers']} 筆",
    )
    check(
        "新學期承接全部在籍學生",
        after_target["active_members"] == before_counts["active_members"],
        f"{after_target['active_members']} / {before_counts['active_members']}",
    )
    check(
        "新學期承接全部編制",
        after_target["active_teachers"] == before_counts["active_teachers"],
        f"{after_target['active_teachers']} / {before_counts['active_teachers']}",
    )
    check(
        "新學期班級數相同",
        after_target["classrooms"] == before_counts["classrooms"],
        f"{after_target['classrooms']} 個",
    )
    check(
        "舊學期已關閉",
        db.get(Semester, source_semester_id).status == "closed",
    )
    check(
        "新學期已啟用",
        db.get(Semester, target_semester_id).status == "active",
    )

    after_projects = snapshot_projects(db)
    changed = [
        project_id
        for project_id, snapshot in before_projects.items()
        if after_projects.get(project_id) != snapshot
    ]
    check(
        f"{len(before_projects)} 本相本的快照與學生完全未變",
        not changed,
        f"變動的相本 id：{changed[:5]}",
    )

    work_slots = db.query(Classroom).filter(
        Classroom.semester_id == target_semester_id
    ).all()
    slotless = [room.name for room in work_slots if not room.work_slots]
    check("新學期每個班都有工作格", not slotless, f"沒有的：{slotless[:5]}")
    target_classroom_ids = {room.id for room in work_slots}
    source_classroom_ids = {
        room.id
        for room in db.query(Classroom).filter(
            Classroom.semester_id == source_semester_id
        )
    }
finally:
    db.close()

print()
print("5) 權限驗證（取樣老師）")
client.cookies.clear()
teacher_login = client.post(
    "/api/auth/login",
    data={"username": sample_teacher_username, "password": "dryrun-teacher"},
)
check("老師可登入", teacher_login.status_code == 200, teacher_login.text[:120])
if sample_project_id is not None:
    detail = client.get(f"/api/projects/{sample_project_id}")
    check("舊相本仍讀得到", detail.status_code == 200, f"HTTP {detail.status_code}")
    if detail.status_code == 200:
        permissions = detail.json()["permissions"]
        check("舊相本可讀", permissions["can_read"] is True)
        check(
            "舊相本不可製作（編制已隨學期結束）",
            permissions["can_edit"] is False,
            f"can_edit={permissions['can_edit']}",
        )
my_classrooms = client.get("/api/organization/my-classrooms")
check("my-classrooms 回 200", my_classrooms.status_code == 200)
if my_classrooms.status_code == 200:
    rows = my_classrooms.json()["classrooms"]
    listed_ids = {row["id"] for row in rows}
    check(
        "my-classrooms 只列新學期的班",
        bool(listed_ids) and listed_ids <= target_classroom_ids,
        f"{len(rows)} 個班",
    )
    check(
        "my-classrooms 不含舊學期的班",
        not (listed_ids & source_classroom_ids),
    )

print()
print("6) 不變式：還能再建下一份草稿")
client.cookies.clear()
client.post(
    "/api/auth/login",
    data={"username": "dryrun_admin", "password": "dryrun-pass"},
)
next_plan = client.post(
    "/api/organization/term-reclassification-plans",
    json={"label": "演練：再下一個學期"},
)
check(
    "沒有殘留的 active 擋住下一次編班",
    next_plan.status_code == 201,
    next_plan.text[:200],
)

print()
if failures:
    print(f"=== {len(failures)} 項失敗 ===")
    for label in failures:
        print(f"  - {label}")
    sys.exit(1)
print("=== 全部通過 ===")
