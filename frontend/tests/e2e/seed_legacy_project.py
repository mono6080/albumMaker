"""為 Playwright 建立 production 已禁止新增的未歸班舊相本 fixture。"""

import json
import os
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
E2E_DB_FILE = REPO_ROOT / ".tmp" / "e2e" / "e2e.db"
os.environ["DATABASE_URL"] = f"sqlite:///{E2E_DB_FILE.as_posix()}"
sys.path.insert(0, str(REPO_ROOT / "backend"))

from database import Project, RosterChild, SessionLocal, Student, Template, User  # noqa: E402


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
            roster_child = RosterChild(name=student_name)
            db.add(roster_child)
            db.flush()
            db.add(Student(
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
