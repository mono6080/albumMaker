# 專案與學生 CRUD 路由
# 處理專案建立/讀取/修改/刪除，以及學生的批次新增、改名、刪除與頁面跳過

import json
from datetime import datetime, timedelta
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
from .schemas import BatchAddResult, OkResult, PageSkipPayload, ProjectCreated, ProjectDetail, ProjectSummary

router = APIRouter()
PROJECT_ARCHIVE_DAYS = 30


@router.get("/", response_model=list[ProjectSummary])
def list_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """依角色回傳可存取的專案摘要清單（依建立時間降序）。"""
    query = _visible_projects_query(db, current_user).filter(Project.deleted_at.is_(None))
    all_projects = query.order_by(Project.created_at.desc()).all()
    return [_serialize_project_summary(project) for project in all_projects]


@router.get("/archive", response_model=list[ProjectSummary])
def list_archived_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """回傳 30 天復原期限內的封存專案。"""
    now = datetime.utcnow()
    query = (
        _visible_projects_query(db, current_user)
        .filter(Project.deleted_at.isnot(None))
        .filter(Project.archive_expires_at > now)
    )
    archived_projects = query.order_by(Project.deleted_at.desc()).all()
    return [_serialize_project_summary(project) for project in archived_projects]


@router.post("/", response_model=ProjectCreated, status_code=201)
def create_project(
    name: str = Form(..., max_length=100),
    template_id: int = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "teacher", "supervisor")),
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
        "deleted_at": project.deleted_at,
        "archive_expires_at": project.archive_expires_at,
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
    """將指定專案封存 30 天，期限內可復原。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    now = datetime.utcnow()
    project.deleted_at = now
    project.archive_expires_at = now + timedelta(days=PROJECT_ARCHIVE_DAYS)
    project.updated_at = now
    db.commit()
    db.refresh(project)
    return {
        "ok": True,
        "deleted_at": project.deleted_at,
        "archive_expires_at": project.archive_expires_at,
    }


@router.post("/{project_id}/restore")
def restore_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """復原 30 天封存期限內的專案。"""
    project = get_project_or_404(project_id, db, include_archived=True)
    assert_project_writable(project, current_user)
    if project.deleted_at is None:
        return {"ok": True}
    now = datetime.utcnow()
    if project.archive_expires_at and project.archive_expires_at <= now:
        raise HTTPException(status_code=410, detail="此專案已超過 30 天復原期限")
    project.deleted_at = None
    project.archive_expires_at = None
    project.updated_at = now
    db.commit()
    return {"ok": True}


def _visible_projects_query(db: Session, current_user: User):
    """依角色回傳可見專案查詢，呼叫端再決定 active/archive 篩選。"""
    from crud.user_crud import get_subordinate_user_ids

    query = db.query(Project).options(joinedload(Project.owner), joinedload(Project.students))

    if current_user.role in ("admin", "art_team"):
        return query
    if current_user.role == "supervisor":
        subordinate_ids = get_subordinate_user_ids(current_user.id, db)
        visible_owner_ids = set(subordinate_ids)
        visible_owner_ids.add(current_user.id)
        return query.filter(Project.owner_id.in_(visible_owner_ids))
    if current_user.role == "teacher":
        return query.filter(Project.owner_id == current_user.id)
    return query.filter(Project.id.is_(None))


def _serialize_project_summary(project: Project) -> dict:
    return {
        "id": project.id,
        "name": project.name,
        "template_id": project.template_id,
        "created_at": project.created_at,
        "student_count": len(project.students),
        "owner_id": project.owner_id,
        "owner_name": project.owner.display_name if project.owner else None,
        "deleted_at": project.deleted_at,
        "archive_expires_at": project.archive_expires_at,
    }


# ── 學生管理 ──────────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/batch", response_model=BatchAddResult)
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

@router.patch("/{project_id}/students/{student_id}/pages/{page_index}/skip", response_model=OkResult)
def set_page_skip(
    project_id: int,
    student_id: int,
    page_index: int,
    payload: PageSkipPayload,
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
    pages_data[page_index]["skip"] = payload.skip
    student.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True}
