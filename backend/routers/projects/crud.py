# 專案與學生 CRUD 路由
# 處理專案建立/讀取/修改/刪除，以及學生的批次新增、改名、刪除與頁面跳過

import json
from typing import Optional

from fastapi import APIRouter, Depends, Form
from fastapi import HTTPException
from sqlalchemy.orm import Session, joinedload

from auth import get_current_user, require_role
from crud.project_crud import get_project_or_404, get_student_or_404
from database import Project, Student, Template, User, get_db
from services.storage import get_storage

from ._helpers import (
    _parse_json_field,
    assert_project_readable,
    assert_project_writable,
)
from .schemas import ProjectDetail, ProjectSummary

router = APIRouter()


@router.get("/", response_model=list[ProjectSummary])
def list_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """依角色回傳可存取的專案摘要清單（依建立時間降序）。"""
    from crud.user_crud import get_subordinate_user_ids
    query = db.query(Project).options(joinedload(Project.owner), joinedload(Project.students))

    if current_user.role == "admin":
        pass  # 看全部
    elif current_user.role in ("art_team",):
        pass  # 看全部（唯讀）
    elif current_user.role == "supervisor":
        subordinate_ids = get_subordinate_user_ids(current_user.id, db)
        query = query.filter(Project.owner_id.in_(subordinate_ids))
    elif current_user.role == "teacher":
        query = query.filter(Project.owner_id == current_user.id)
    else:
        return []

    all_projects = query.order_by(Project.created_at.desc()).all()
    return [
        {
            "id": project.id,
            "name": project.name,
            "template_id": project.template_id,
            "created_at": project.created_at,
            "student_count": len(project.students),
            "owner_id": project.owner_id,
            "owner_name": project.owner.display_name if project.owner else None,
        }
        for project in all_projects
    ]


@router.post("/")
def create_project(
    name: str = Form(..., max_length=100),
    template_id: int = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "teacher")),
):
    """建立新專案，需指定使用的模板，自動設定所有者為當前使用者。"""
    template = db.query(Template).filter(Template.id == template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="找不到模板")

    new_project = Project(name=name, template_id=template_id, owner_id=current_user.id)
    db.add(new_project)
    db.commit()
    db.refresh(new_project)
    return {"id": new_project.id, "name": new_project.name}


@router.get("/{project_id}", response_model=ProjectDetail)
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """回傳專案詳細資訊，包含所有學生與其頁面資料。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    return {
        "id": project.id,
        "name": project.name,
        "template_id": project.template_id,
        "created_at": project.created_at,
        "owner_id": project.owner_id,
        "label_texts": _parse_json_field(project.label_texts_json or "{}", "label_texts_json"),
        "students": [
            {
                "id": student.id,
                "name": student.name,
                "order_index": student.order_index,
                "pages_data": _parse_json_field(student.pages_data_json, "pages_data_json"),
                "output_filename": student.output_filename,
            }
            for student in project.students
        ],
    }


@router.patch("/{project_id}")
def rename_project(
    project_id: int,
    name: str = Form(..., max_length=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """修改專案名稱（行內編輯）。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    project.name = name.strip()
    db.commit()
    return {"ok": True}


@router.delete("/{project_id}")
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """刪除指定專案及其所有學生資料與上傳檔案。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    # 先刪檔案再 commit：避免 DB 已提交但檔案刪除失敗造成孤立記錄
    get_storage().delete_prefix(f"projects/proj{project_id}")
    db.delete(project)
    db.commit()
    return {"ok": True}


# ── 學生管理 ──────────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/batch")
def batch_add_students(
    project_id: int,
    names: list[str],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """批次新增多位學生，自動跳過空白名稱與重複名稱。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)

    existing_names = {student.name for student in project.students}
    created_names = []
    skipped_names = []
    names_seen_in_batch = set()
    next_order_index = max(
        (student.order_index for student in project.students),
        default=-1
    ) + 1

    for raw_name in names:
        student_name = raw_name.strip()
        if not student_name:
            continue
        if student_name in existing_names or student_name in names_seen_in_batch:
            skipped_names.append(student_name)
            continue

        names_seen_in_batch.add(student_name)
        new_student = Student(
            project_id=project_id,
            name=student_name,
            order_index=next_order_index,
            pages_data_json="[]",
        )
        db.add(new_student)
        created_names.append(student_name)
        next_order_index += 1

    db.commit()
    return {"created": created_names, "skipped": skipped_names}


@router.put("/{project_id}/students/{student_id}")
def update_student(
    project_id: int,
    student_id: int,
    name: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新學生基本資料（目前支援修改姓名）。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    if name:
        student.name = name
    db.commit()
    return {"ok": True}


@router.delete("/{project_id}/students/{student_id}")
def delete_student(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """刪除指定學生及其所有資料與照片檔案。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    db.delete(student)
    db.commit()
    get_storage().delete_prefix(f"projects/proj{project_id}/photos/student{student_id}")
    return {"ok": True}


# ── 頁面跳過（個別學生刪除頁） ───────────────────────────────────────────────

@router.patch("/{project_id}/students/{student_id}/pages/{page_index}/skip")
def set_page_skip(
    project_id: int,
    student_id: int,
    page_index: int,
    payload: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """設定或取消學生某頁的跳過旗標（渲染時略過此頁）。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = _parse_json_field(student.pages_data_json, "pages_data_json")
    while len(pages_data) <= page_index:
        pages_data.append({
            "page_index": len(pages_data),
            "photos": {},
            "label_texts": {},
        })
    pages_data[page_index]["skip"] = bool(payload.get("skip", True))
    student.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True}
