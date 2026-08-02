"""為 Playwright 建立 production 已禁止新增的未歸班舊相本 fixture。"""

import json
import os
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
# 每個 Playwright worker 有自己的資料庫（見 frontend/tests/e2e/fixtures.js），
# 這支腳本必須寫進呼叫它的那個 worker 的那一份，否則會 seed 到別人的資料庫去。
WORKER_INDEX = os.environ.get("ALBUM_MAKER_E2E_INDEX", "0")
E2E_DB_FILE = REPO_ROOT / ".tmp" / "e2e" / f"w{WORKER_INDEX}" / "e2e.db"
os.environ["DATABASE_URL"] = f"sqlite:///{E2E_DB_FILE.as_posix()}"
sys.path.insert(0, str(REPO_ROOT / "backend"))

from database import Project, ProjectStudent, SessionLocal, Student, Template, User  # noqa: E402


def main() -> None:
    payload = json.loads(sys.argv[1])
    db = SessionLocal()
    try:
        template = db.query(Template).filter(Template.id == payload["template_id"]).one()
        admin = db.query(User).filter(User.username == "admin").one()
        project = Project(
            name=payload["name"],
            template_id=template.id,
            department=template.period.department,
            template_period_id=template.period_id,
            template_revision=template.revision,
            owner_id=admin.id,
            created_by_id=admin.id,
            created_by_name=admin.display_name,
        )
        db.add(project)
        db.flush()
        for order_index, student_name in enumerate(payload["student_names"]):
            roster_child = Student(name=student_name)
            db.add(roster_child)
            db.flush()
            db.add(ProjectStudent(
                project_id=project.id,
                name=student_name,
                order_index=order_index,
                pages_data_json="[]",
                roster_child_id=roster_child.id,
            ))
        db.commit()
        print(json.dumps({"id": project.id, "name": project.name}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
