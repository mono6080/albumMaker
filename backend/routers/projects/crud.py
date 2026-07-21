# 專案與學生 CRUD 路由
# 處理專案建立/讀取/修改/刪除，以及學生快照的相本稱呼與頁面操作

from fastapi import APIRouter, Depends, Form, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from auth import get_current_user
from crud.project_crud import get_project_or_404, get_student_or_404
from database import Classroom, Project, ProjectComment, Student, User, get_db, utc_now
from services.organization_scope_service import OrganizationReadScope
from services.project_access_service import (
    apply_project_read_scope,
    build_project_access_scope,
    get_project_permissions,
)
from services.project_lifecycle_service import (
    archive_project as archive_project_use_case,
    complete_project as complete_project_use_case,
    complete_project_student as complete_project_student_use_case,
    rename_project as rename_project_use_case,
    reopen_project as reopen_project_use_case,
    reopen_project_student as reopen_project_student_use_case,
    restore_project as restore_project_use_case,
)
from services.project_student_service import (
    auto_fill_student_album_name as auto_fill_student_album_name_use_case,
    auto_fill_student_album_names as auto_fill_student_album_names_use_case,
    set_page_skip as set_page_skip_use_case,
    update_student_album_name as update_student_album_name_use_case,
)
from template_periods import department_label

from ._helpers import (
    _parse_json_field,
    assert_project_readable,
)
from .schemas import (
    AutoFillAlbumNamesResult,
    OkResult,
    PageSkipPayload,
    ProjectDetail,
    ProjectSummary,
    StudentEditorDetail,
    StudentAlbumNameUpdate,
    StudentIdentityResult,
)

router = APIRouter()


@router.get("/", response_model=list[ProjectSummary])
def list_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """依角色回傳可存取的專案摘要清單（依建立時間降序）。"""
    organization_scope = build_project_access_scope(db, current_user)
    query = _visible_projects_query(
        db, current_user, organization_scope
    ).filter(Project.deleted_at.is_(None))
    all_projects = query.order_by(Project.created_at.desc()).all()
    return [
        _serialize_project_summary(
            project,
            student_count,
            comment_count,
            current_user,
            db,
            organization_scope,
        )
        for project, student_count, comment_count in all_projects
    ]


@router.get("/archive", response_model=list[ProjectSummary])
def list_archived_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """回傳 30 天復原期限內的封存專案。"""
    now = utc_now()
    organization_scope = build_project_access_scope(db, current_user)
    query = (
        _visible_projects_query(db, current_user, organization_scope)
        .filter(Project.deleted_at.isnot(None))
        .filter(Project.archive_expires_at > now)
    )
    archived_projects = query.order_by(Project.deleted_at.desc()).all()
    return [
        _serialize_project_summary(
            project,
            student_count,
            comment_count,
            current_user,
            db,
            organization_scope,
        )
        for project, student_count, comment_count in archived_projects
    ]


@router.get("/{project_id}", response_model=ProjectDetail)
def get_project(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """回傳專案詳細資訊，包含所有學生與其頁面資料。"""
    project = get_project_or_404(project_id, db)
    organization_scope = build_project_access_scope(db, current_user)
    assert_project_readable(project, current_user, db, organization_scope)
    campus_name, classroom_name = _project_organization_names(project)
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
        "classroom_id": project.classroom_id,
        "campus_name": campus_name,
        "classroom_name": classroom_name,
        "owner_id": project.owner_id,
        "owner_name": project.owner.display_name if project.owner else None,
        "created_by_id": project.created_by_id,
        "created_by_name": project.created_by_name,
        "deleted_at": project.deleted_at,
        "archive_expires_at": project.archive_expires_at,
        "completed_at": project.completed_at,
        "updated_at": project.updated_at,
        "label_texts": _parse_json_field(project.label_texts_json or "{}", "label_texts_json"),
        "permissions": get_project_permissions(
            project, current_user, db, organization_scope
        ),
        "students": [
            {
                "id": student.id,
                "name": student.name,
                "album_name": student.resolved_album_name,
                "effective_album_name": student.effective_album_name,
                "order_index": student.order_index,
                "pages_data": _parse_json_field(student.pages_data_json, "pages_data_json"),
                "output_filename": student.output_filename,
                "completed_at": student.completed_at,
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
    organization_scope = build_project_access_scope(db, current_user)
    assert_project_readable(project, current_user, db, organization_scope)
    student = get_student_or_404(student_id, project_id, db)
    student_summaries = (
        db.query(Student)
        .options(joinedload(Student.roster_child))
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
            "permissions": get_project_permissions(
                project, current_user, db, organization_scope
            ),
            "students": [
                {
                    "id": item.id,
                    "name": item.name,
                    "album_name": item.resolved_album_name,
                    "effective_album_name": item.effective_album_name,
                    "order_index": item.order_index,
                }
                for item in student_summaries
            ],
        },
        "student": {
            "id": student.id,
            "name": student.name,
            "album_name": student.resolved_album_name,
            "effective_album_name": student.effective_album_name,
            "order_index": student.order_index,
            "pages_data": _parse_json_field(student.pages_data_json, "pages_data_json"),
            "output_filename": student.output_filename,
            "completed_at": student.completed_at,
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


@router.post("/{project_id}/students/{student_id}/complete")
def complete_project_student(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """標記單一學生相本完成；全班皆完成時同 transaction 自動成立全班完成。"""
    return complete_project_student_use_case(db, current_user, project_id, student_id)


@router.post("/{project_id}/students/{student_id}/reopen")
def reopen_project_student(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """退回單一學生完成（僅主管或 admin）；全班完成已成立時一併解除。"""
    return reopen_project_student_use_case(db, current_user, project_id, student_id)


def _visible_projects_query(
    db: Session,
    current_user: User,
    organization_scope: OrganizationReadScope | None,
):
    """依角色回傳可見專案查詢，呼叫端再決定 active/archive 篩選。"""
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
        joinedload(Project.classroom).joinedload(Classroom.campus),
    )

    return apply_project_read_scope(query, current_user, db, organization_scope)


def _serialize_project_summary(
    project: Project,
    student_count: int,
    comment_count: int,
    current_user: User,
    db: Session,
    organization_scope: OrganizationReadScope | None,
) -> dict:
    campus_name, classroom_name = _project_organization_names(project)
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
        "classroom_id": project.classroom_id,
        "campus_name": campus_name,
        "classroom_name": classroom_name,
        "owner_id": project.owner_id,
        "owner_name": project.owner.display_name if project.owner else None,
        "created_by_id": project.created_by_id,
        "created_by_name": project.created_by_name,
        "deleted_at": project.deleted_at,
        "archive_expires_at": project.archive_expires_at,
        "completed_at": project.completed_at,
        "permissions": get_project_permissions(
            project, current_user, db, organization_scope
        ),
    }


def _project_organization_names(project: Project) -> tuple[str | None, str | None]:
    return project.campus_name_snapshot, project.classroom_name_snapshot


# ── 學生管理 ──────────────────────────────────────────────────────────────────

@router.post(
    "/{project_id}/students/album-names/auto-fill",
    response_model=AutoFillAlbumNamesResult,
)
def auto_fill_student_album_names(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """只為尚未設定相本稱呼的既有學生做保守自動推導。"""
    return auto_fill_student_album_names_use_case(
        db,
        current_user,
        project_id,
    )


@router.post(
    "/{project_id}/students/{student_id}/album-name/auto-fill",
    response_model=AutoFillAlbumNamesResult,
)
def auto_fill_student_album_name(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """只為指定學生尚未設定的相本稱呼做保守自動推導。"""
    return auto_fill_student_album_name_use_case(
        db, current_user, project_id, student_id
    )


@router.put(
    "/{project_id}/students/{student_id}/album-name",
    response_model=StudentIdentityResult,
)
def update_student_album_name(
    project_id: int,
    student_id: int,
    payload: StudentAlbumNameUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """只更新相本稱呼；學生完整姓名由建立當下的班級名單快照決定。"""
    return update_student_album_name_use_case(
        db,
        current_user,
        project_id,
        student_id,
        payload.album_name,
    )


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
