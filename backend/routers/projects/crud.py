# 專案與學生 CRUD 路由
# 處理專案建立/讀取/修改/刪除，以及學生的批次新增、改名、刪除與頁面跳過

from typing import Optional

from fastapi import APIRouter, Depends, Form, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from auth import get_current_user, require_role
from crud.project_crud import get_project_or_404, get_student_or_404
from database import Project, ProjectComment, Student, User, get_db, utc_now
from services.project_archive_service import purge_expired_archived_projects
from services.project_lifecycle_service import (
    archive_project as archive_project_use_case,
    complete_project as complete_project_use_case,
    create_project as create_project_use_case,
    rename_project as rename_project_use_case,
    reopen_project as reopen_project_use_case,
    restore_project as restore_project_use_case,
)
from services.project_student_service import (
    batch_add_students as batch_add_students_use_case,
    copy_students_from_project as copy_students_from_project_use_case,
    delete_student as delete_student_use_case,
    set_page_skip as set_page_skip_use_case,
    update_student as update_student_use_case,
)
from template_periods import department_label

from ._helpers import (
    _parse_json_field,
    assert_project_readable,
)
from .schemas import (
    BatchAddResult,
    CopyStudentsPayload,
    OkResult,
    PageSkipPayload,
    ProjectCreated,
    ProjectDetail,
    ProjectSummary,
    StudentEditorDetail,
)

router = APIRouter()


@router.get("/", response_model=list[ProjectSummary])
def list_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """依角色回傳可存取的專案摘要清單（依建立時間降序）。"""
    query = _visible_projects_query(db, current_user).filter(Project.deleted_at.is_(None))
    all_projects = query.order_by(Project.created_at.desc()).all()
    return [_serialize_project_summary(project, student_count, comment_count) for project, student_count, comment_count in all_projects]


@router.get("/archive", response_model=list[ProjectSummary])
def list_archived_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """回傳 30 天復原期限內的封存專案。"""
    now = utc_now()
    purge_expired_archived_projects(db, now)
    query = (
        _visible_projects_query(db, current_user)
        .filter(Project.deleted_at.isnot(None))
        .filter(Project.archive_expires_at > now)
    )
    archived_projects = query.order_by(Project.deleted_at.desc()).all()
    return [_serialize_project_summary(project, student_count, comment_count) for project, student_count, comment_count in archived_projects]


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
    return create_project_use_case(
        db,
        current_user,
        name=name,
        template_id=template_id,
        department=department,
        template_period_id=template_period_id,
    )


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
        "template_revision": project.template_revision,
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


@router.get("/{project_id}/students/{student_id}/editor", response_model=StudentEditorDetail)
def get_student_editor_detail(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """回傳個別編輯器資料；只有目前學生包含 pages_data。"""
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)
    student_summaries = (
        db.query(Student.id, Student.name, Student.order_index)
        .filter(Student.project_id == project_id)
        .order_by(Student.order_index)
        .all()
    )
    return {
        "project": {
            "id": project.id,
            "name": project.name,
            "template_id": project.template_id,
            "template_revision": project.template_revision,
            "owner_id": project.owner_id,
            "completed_at": project.completed_at,
            "label_texts": _parse_json_field(project.label_texts_json or "{}", "label_texts_json"),
            "students": [
                {"id": item.id, "name": item.name, "order_index": item.order_index}
                for item in student_summaries
            ],
        },
        "student": {
            "id": student.id,
            "name": student.name,
            "order_index": student.order_index,
            "pages_data": _parse_json_field(student.pages_data_json, "pages_data_json"),
            "output_filename": student.output_filename,
            "updated_at": student.updated_at,
        },
    }


@router.patch("/{project_id}")
def rename_project(
    project_id: int,
    name: str = Form(..., max_length=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """修改專案名稱（行內編輯）。"""
    return rename_project_use_case(db, current_user, project_id, name)


@router.delete("/{project_id}")
def delete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """將指定專案封存 30 天，期限內可復原。"""
    return archive_project_use_case(db, current_user, project_id)


@router.post("/{project_id}/restore")
def restore_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """復原 30 天封存期限內的專案。"""
    return restore_project_use_case(db, current_user, project_id)


@router.post("/{project_id}/complete")
def complete_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """標記全班完成：內容鎖定（名單/照片/文字），需主管或 admin 退回才能再修改。"""
    return complete_project_use_case(db, current_user, project_id)


@router.post("/{project_id}/reopen")
def reopen_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """退回「全班完成」標記，恢復可編輯（限管轄該老師的主管或 admin）。"""
    return reopen_project_use_case(db, current_user, project_id)


def _visible_projects_query(db: Session, current_user: User):
    """依角色回傳可見專案查詢，呼叫端再決定 active/archive 篩選。"""
    from crud.user_crud import get_visible_owner_ids

    student_count = (
        db.query(func.count(Student.id))
        .filter(Student.project_id == Project.id)
        .correlate(Project)
        .scalar_subquery()
    )
    comment_count = (
        db.query(func.count(ProjectComment.id))
        .filter(ProjectComment.project_id == Project.id)
        .correlate(Project)
        .scalar_subquery()
    )
    query = db.query(Project, student_count, comment_count).options(
        joinedload(Project.owner),
        joinedload(Project.template_period),
    )

    visible_owner_ids = get_visible_owner_ids(current_user, db)
    if visible_owner_ids is None:
        return query
    return query.filter(Project.owner_id.in_(visible_owner_ids))


def _serialize_project_summary(project: Project, student_count: int, comment_count: int) -> dict:
    return {
        "id": project.id,
        "name": project.name,
        "template_id": project.template_id,
        "department": project.department,
        "department_label": department_label(project.department),
        "template_period_id": project.template_period_id,
        "template_period_name": project.template_period.name if project.template_period else None,
        "created_at": project.created_at,
        "student_count": student_count,
        "comment_count": comment_count,
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
    return batch_add_students_use_case(db, current_user, project_id, names)


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
    return copy_students_from_project_use_case(
        db,
        current_user,
        project_id,
        payload.source_project_id,
    )


@router.put("/{project_id}/students/{student_id}")
def update_student(
    project_id: int,
    student_id: int,
    name: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """更新學生基本資料（目前支援修改姓名）。"""
    return update_student_use_case(db, current_user, project_id, student_id, name)


@router.delete("/{project_id}/students/{student_id}")
def delete_student(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """刪除指定學生及其所有資料與照片檔案。"""
    return delete_student_use_case(db, current_user, project_id, student_id)


# ── 頁面跳過（個別學生刪除頁） ───────────────────────────────────────────────

@router.patch("/{project_id}/students/{student_id}/pages/{page_index}/skip", response_model=OkResult)
def set_page_skip(
    project_id: int,
    student_id: int,
    page_index: int,
    payload: PageSkipPayload,
    expected_template_revision: int = Query(..., ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """設定或取消學生某頁的跳過旗標（渲染時略過此頁）。"""
    return set_page_skip_use_case(
        db,
        current_user,
        project_id,
        student_id,
        page_index,
        payload.skip,
        expected_template_revision,
    )
