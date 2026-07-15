# 專案與學生 CRUD 路由
# 處理專案建立/讀取/修改/刪除，以及學生的批次新增、改名、刪除與頁面跳過

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Form, Query
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from auth import get_current_user, require_role
from crud.project_crud import get_project_or_404, get_student_or_404
from database import Project, ProjectComment, Student, User, get_db, utc_now
from services.roster_service import delete_roster_child_if_orphaned, resolve_roster_child_id
from services.project_archive_service import purge_expired_archived_projects
from services.project_lifecycle_service import (
    archive_project as archive_project_use_case,
    complete_project as complete_project_use_case,
    create_project as create_project_use_case,
    rename_project as rename_project_use_case,
    reopen_project as reopen_project_use_case,
    restore_project as restore_project_use_case,
)
from services.project_template_revision import lock_project_template_revision
from services.storage import get_storage
from services.student_render_service import clear_student_render_outputs
from services.student_pages import (
    ensure_page_entry,
    lock_student_page_writes,
    mutate_student_pages,
)
from services.template_sync_locks import lock_project_content_writes
from template_periods import department_label

from ._helpers import (
    _parse_json_field,
    assert_project_content_writable,
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
logger = logging.getLogger(__name__)


def _clear_student_outputs_best_effort(
    storage,
    project_id: int,
    project_name: str,
    student_name: str,
    output_filename: str | None,
) -> None:
    """DB mutation 已提交後，輸出清理失敗只留紀錄，不把成功操作偽裝成失敗。"""
    try:
        clear_student_render_outputs(
            storage,
            project_id,
            project_name,
            student_name,
            output_filename,
        )
    except Exception:
        logger.exception(
            "學生輸出清理失敗 project_id=%s student_name=%s",
            project_id,
            student_name,
        )


def _delete_storage_prefix_best_effort(storage, prefix: str) -> None:
    """刪除已失去 DB binding 的 storage namespace；失敗時保留可追查日誌。"""
    try:
        storage.delete_prefix(prefix)
    except Exception:
        logger.exception("Storage prefix 清理失敗 prefix=%s", prefix)


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
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    with lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
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
    with lock_project_content_writes([project_id, payload.source_project_id]):
        db.rollback()
        db.expire_all()
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
    get_student_or_404(student_id, project_id, db)
    with (
        lock_project_content_writes([project_id]),
        lock_student_page_writes([student_id]),
    ):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_content_writable(project, current_user)
        student = get_student_or_404(student_id, project_id, db)
        if not name or student.name == name:
            db.rollback()
            return {"ok": True}

        previous_name = student.name
        previous_output_filename = student.output_filename
        previous_child_id = student.roster_child_id
        now = utc_now()
        student.name = name
        student.output_filename = None
        student.updated_at = now
        project.updated_at = now
        # 改名後重新解析名冊連結（改回同名孩子或成為新孩子），舊名冊項變孤兒則清掉
        student.roster_child_id = resolve_roster_child_id(db, name)
        if previous_child_id != student.roster_child_id:
            db.flush()
            delete_roster_child_if_orphaned(db, previous_child_id)
        db.commit()

        _clear_student_outputs_best_effort(
            get_storage(),
            project_id,
            project.name,
            previous_name,
            previous_output_filename,
        )
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
    get_student_or_404(student_id, project_id, db)
    storage = get_storage()
    with (
        lock_project_content_writes([project_id]),
        lock_student_page_writes([student_id]),
    ):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_content_writable(project, current_user)
        student = get_student_or_404(student_id, project_id, db)
        previous_name = student.name
        previous_output_filename = student.output_filename
        previous_child_id = student.roster_child_id
        project.updated_at = utc_now()
        db.delete(student)
        db.flush()
        delete_roster_child_if_orphaned(db, previous_child_id)
        db.commit()

        _clear_student_outputs_best_effort(
            storage,
            project_id,
            project.name,
            previous_name,
            previous_output_filename,
        )
        # 保持 project lock 到舊照片 namespace 清除完成，避免 SQLite 重用剛刪除的
        # 最大 student id 後，舊請求誤刪新學生剛上傳的照片。
        _delete_storage_prefix_best_effort(
            storage,
            f"projects/proj{project_id}/photos/student{student_id}",
        )
    return {"ok": True}


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
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    with lock_project_template_revision(db, project, expected_template_revision):
        assert_project_content_writable(project, current_user)
        student = get_student_or_404(student_id, project_id, db)

        # 進學生寫鎖：與照片上傳/文字儲存併發打同一學生時不互相蓋寫 pages_data
        def _mutate(pages_data) -> None:
            ensure_page_entry(pages_data, page_index)["skip"] = payload.skip

        mutate_student_pages(db, student, _mutate)
    return {"ok": True}
