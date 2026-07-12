# 專案與學生 CRUD 路由
# 處理專案建立/讀取/修改/刪除，以及學生的批次新增、改名、刪除與頁面跳過

from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Form
from fastapi import HTTPException
from sqlalchemy.orm import Session, joinedload, selectinload

from auth import get_current_user, require_role
from crud.project_crud import get_project_or_404, get_student_or_404
from database import Project, Student, Template, User, get_db
from services.roster_service import delete_roster_child_if_orphaned, resolve_roster_child_id
from services.storage import get_storage
from services.student_pages import ensure_page_entry, mutate_student_pages
from template_periods import department_label

from ._helpers import (
    _parse_json_field,
    assert_project_completion_revertible,
    assert_project_content_writable,
    assert_project_readable,
    assert_project_writable,
)
from .schemas import (
    BatchAddResult,
    CopyStudentsPayload,
    OkResult,
    PageSkipPayload,
    ProjectCreated,
    ProjectDetail,
    ProjectSummary,
)

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
    department: Optional[str] = Form(None),
    template_period_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_role("admin", "teacher", "supervisor")),
):
    """建立新專案，需指定使用的模板，自動設定所有者為當前使用者。"""
    template = db.query(Template).filter(Template.id == template_id).first()
    if not template:
        raise HTTPException(status_code=404, detail="找不到模板")

    project_department = department
    project_period_id = template_period_id
    if template.period:
        if department and department != template.period.department:
            raise HTTPException(status_code=400, detail="模板不屬於所選部門")
        if template_period_id and template_period_id != template.period.id:
            raise HTTPException(status_code=400, detail="模板不屬於所選期別")
        if template.period.status != "active":
            raise HTTPException(status_code=400, detail="只能使用「使用中」期別的模板建立專案")
        project_department = template.period.department
        project_period_id = template.period.id

    new_project = Project(
        name=name,
        template_id=template_id,
        owner_id=current_user.id,
        department=project_department,
        template_period_id=project_period_id,
    )
    db.add(new_project)
    db.commit()
    db.refresh(new_project)
    return {
        "id": new_project.id,
        "name": new_project.name,
        "department": new_project.department,
        "template_period_id": new_project.template_period_id,
    }


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
        "department": project.department,
        "department_label": department_label(project.department),
        "template_period_id": project.template_period_id,
        "template_period_name": project.template_period.name if project.template_period else None,
        "created_at": project.created_at,
        "owner_id": project.owner_id,
        "deleted_at": project.deleted_at,
        "archive_expires_at": project.archive_expires_at,
        "completed_at": project.completed_at,
        "updated_at": project.updated_at,
        "label_texts": _parse_json_field(project.label_texts_json or "{}", "label_texts_json"),
        "students": [
            {
                "id": student.id,
                "name": student.name,
                "order_index": student.order_index,
                "pages_data": _parse_json_field(student.pages_data_json, "pages_data_json"),
                "output_filename": student.output_filename,
                "updated_at": student.updated_at,
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


@router.post("/{project_id}/complete")
def complete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """標記全班完成：內容鎖定（名單/照片/文字），需主管或 admin 退回才能再修改。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    # 空專案沒有「完成」可言，擋下誤觸（一鎖名單就什麼都動不了）
    if not project.students:
        raise HTTPException(status_code=400, detail="尚無學生，無法標記全班完成")
    if project.completed_at is None:
        project.completed_at = datetime.utcnow()
        db.commit()
    return {"ok": True, "completed_at": project.completed_at}


@router.post("/{project_id}/reopen")
def reopen_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """退回「全班完成」標記，恢復可編輯（限管轄該老師的主管或 admin）。"""
    project = get_project_or_404(project_id, db)
    assert_project_completion_revertible(project, current_user, db)
    project.completed_at = None
    db.commit()
    return {"ok": True}


def _visible_projects_query(db: Session, current_user: User):
    """依角色回傳可見專案查詢，呼叫端再決定 active/archive 篩選。"""
    from crud.user_crud import get_visible_owner_ids

    # comments 用 selectinload：與 students 同為集合，兩個 joinedload 會產生笛卡兒積
    query = db.query(Project).options(
        joinedload(Project.owner),
        joinedload(Project.students),
        selectinload(Project.comments),
    )

    visible_owner_ids = get_visible_owner_ids(current_user, db)
    if visible_owner_ids is None:
        return query
    return query.filter(Project.owner_id.in_(visible_owner_ids))


def _serialize_project_summary(project: Project) -> dict:
    return {
        "id": project.id,
        "name": project.name,
        "template_id": project.template_id,
        "department": project.department,
        "department_label": department_label(project.department),
        "template_period_id": project.template_period_id,
        "template_period_name": project.template_period.name if project.template_period else None,
        "created_at": project.created_at,
        "student_count": len(project.students),
        "comment_count": len(project.comments),
        "owner_id": project.owner_id,
        "owner_name": project.owner.display_name if project.owner else None,
        "deleted_at": project.deleted_at,
        "archive_expires_at": project.archive_expires_at,
        "completed_at": project.completed_at,
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
    assert_project_content_writable(project, current_user)

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
            # 自動連結名冊：同名唯一則連既有孩子、查無自動建立、歧義留 None 待確認
            roster_child_id=resolve_roster_child_id(db, student_name),
        )
        db.add(new_student)
        created_names.append(student_name)
        next_order_index += 1

    db.commit()
    return {"created": created_names, "skipped": skipped_names}


@router.post("/{project_id}/students/copy", response_model=BatchAddResult)
def copy_students_from_project(
    project_id: int,
    payload: CopyStudentsPayload,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """從既有專案複製學生名單（含名冊連結），同名學生自動跳過。

    直接沿用來源學生的 roster_child_id，跨期身分 100% 延續、不經同名解析。
    """
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    source_project = get_project_or_404(payload.source_project_id, db)
    assert_project_readable(source_project, current_user, db)

    existing_names = {student.name for student in project.students}
    created_names = []
    skipped_names = []
    next_order_index = max(
        (student.order_index for student in project.students),
        default=-1
    ) + 1

    for source_student in source_project.students:
        if source_student.name in existing_names:
            skipped_names.append(source_student.name)
            continue
        existing_names.add(source_student.name)
        db.add(Student(
            project_id=project_id,
            name=source_student.name,
            order_index=next_order_index,
            pages_data_json="[]",
            roster_child_id=source_student.roster_child_id,
        ))
        created_names.append(source_student.name)
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
    assert_project_content_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    if name:
        previous_child_id = student.roster_child_id
        student.name = name
        # 改名後重新解析名冊連結（改回同名孩子或成為新孩子），舊名冊項變孤兒則清掉
        student.roster_child_id = resolve_roster_child_id(db, name)
        if previous_child_id != student.roster_child_id:
            db.flush()
            delete_roster_child_if_orphaned(db, previous_child_id)
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
    assert_project_content_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    previous_child_id = student.roster_child_id
    db.delete(student)
    db.flush()
    delete_roster_child_if_orphaned(db, previous_child_id)
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
    assert_project_content_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)

    # 進學生寫鎖：與照片上傳/文字儲存併發打同一學生時不互相蓋寫 pages_data
    def _mutate(pages_data) -> None:
        ensure_page_entry(pages_data, page_index)["skip"] = payload.skip

    mutate_student_pages(db, student, _mutate)
    return {"ok": True}
