"""專案建立、改名、封存、復原與完成狀態 use cases。"""

import json
import logging
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404, get_student_or_404
from database import Project, Template, User, utc_now
from services.organization_lock import organization_acl_lock
from services.project_access_service import (
    assert_project_completion_revertible,
    assert_project_writable,
)
from services.project_archive_service import purge_expired_archived_projects
from services.storage_factory import get_storage
from services.student_progress import summarize_student_progress
from services.student_render_service import (
    clear_student_render_outputs,
    get_template_page_layouts,
)
from services.template_sync_locks import lock_project_content_writes


PROJECT_ARCHIVE_DAYS = 30
logger = logging.getLogger(__name__)


def _clear_student_outputs_best_effort(
    storage,
    project_id: int,
    student_id: int,
    student_name: str,
    output_filename: str | None,
) -> None:
    """改名已提交後，輸出清理失敗只記錄，不改寫成功回應。"""
    try:
        clear_student_render_outputs(
            storage,
            project_id,
            student_id,
            output_filename,
        )
    except Exception:
        logger.exception(
            "學生輸出清理失敗 project_id=%s student_id=%s student_name=%s",
            project_id,
            student_id,
            student_name,
        )


def build_project_record(
    db: Session,
    template: Template,
    creator: User,
    owner: User,
    *,
    name: str,
    department: str | None,
    template_period_id: int | None,
    classroom_id: int,
    class_period_work_slot_id: int,
    campus_id_snapshot: int,
    campus_name_snapshot: str,
    classroom_name_snapshot: str,
) -> Project:
    """驗證模板 scope 後建立未提交的班級 Project。"""
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
        template_id=template.id,
        template_revision=template.revision,
        owner_id=owner.id,
        classroom_id=classroom_id,
        class_period_work_slot_id=class_period_work_slot_id,
        created_by_id=creator.id,
        created_by_name=creator.display_name,
        campus_id_snapshot=campus_id_snapshot,
        campus_name_snapshot=campus_name_snapshot,
        classroom_name_snapshot=classroom_name_snapshot,
        department=project_department,
        template_period_id=project_period_id,
    )
    db.add(new_project)
    return new_project


def rename_project(db: Session, current_user: User, project_id: int, name: str) -> dict:
    """改名並在 commit 後、仍持有 P 鎖時 best-effort 清除舊輸出。

    改名不受任何完成狀態限制（get_project_or_404 已排除封存專案）：
    名稱只進輸出檔名與渲染快取 token，不進相本內容。
    """
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user, db)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_writable(project, current_user, db)
        normalized_name = name.strip()
        if project.name == normalized_name:
            db.rollback()
            return {"ok": True}

        output_states = [
            (student.id, student.name, student.output_filename)
            for student in project.students
        ]
        project.name = normalized_name
        project.updated_at = utc_now()
        for student in project.students:
            student.output_filename = None
        db.commit()

        storage = get_storage()
        for student_id, student_name, output_filename in output_states:
            _clear_student_outputs_best_effort(
                storage,
                project_id,
                student_id,
                student_name,
                output_filename,
            )
    return {"ok": True}


def archive_project(db: Session, current_user: User, project_id: int) -> dict:
    """封存專案並設定復原期限。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user, db)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_writable(project, current_user, db)
        now = utc_now()
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


def restore_project(db: Session, current_user: User, project_id: int) -> dict:
    """復原未到期封存；已到期者在釋放 P 鎖後交給 purge。"""
    project = get_project_or_404(project_id, db, include_archived=True)
    assert_project_writable(project, current_user, db)
    expired_at_lock = False
    now = None
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db, include_archived=True)
        assert_project_writable(project, current_user, db)
        now = utc_now()
        if project.deleted_at is None:
            return {"ok": True}
        if project.archive_expires_at and project.archive_expires_at <= now:
            expired_at_lock = True
        else:
            project.deleted_at = None
            project.archive_expires_at = None
            project.updated_at = now
            db.commit()
            return {"ok": True}
    if expired_at_lock:
        purge_expired_archived_projects(db, now)
    raise HTTPException(status_code=404, detail="專案不存在或已清除")


def complete_project(db: Session, current_user: User, project_id: int) -> dict:
    """標記全班完成，空專案維持拒絕。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user, db)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_writable(project, current_user, db)
        if not project.students:
            raise HTTPException(status_code=400, detail="尚無學生，無法標記全班完成")
        if project.completed_at is None:
            project.completed_at = utc_now()
            db.commit()
        return {"ok": True, "completed_at": project.completed_at}


def reopen_project(db: Session, current_user: User, project_id: int) -> dict:
    """由主管或管理員退回完成狀態；全班退回同時清除全部學生的個別完成。"""
    project = get_project_or_404(project_id, db)
    assert_project_completion_revertible(project, current_user, db)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_completion_revertible(project, current_user, db)
        project.completed_at = None
        for student in project.students:
            student.completed_at = None
        db.commit()
        return {"ok": True}


def _assert_student_content_filled(project: Project, student) -> None:
    """標記單生完成的前置條件：照片與可填文字全數填滿（與老師進度同一計算）。"""
    photo_filled, photo_total, text_filled, text_total = summarize_student_progress(
        json.loads(student.pages_data_json or "[]"),
        get_template_page_layouts(project),
        json.loads(project.label_texts_json or "{}"),
    )
    if photo_filled < photo_total or text_filled < text_total:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "student_content_incomplete",
                "message": "這位學生的照片或文字尚未填完，補齊後才能標記完成",
                "photo_filled": photo_filled,
                "photo_total": photo_total,
                "text_filled": text_filled,
                "text_total": text_total,
            },
        )


def complete_project_student(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
) -> dict:
    """標記單一學生完成；全班皆完成時在同一 transaction 自動成立全班完成。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user, db)
    get_student_or_404(student_id, project_id, db)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_writable(project, current_user, db)
        student = get_student_or_404(student_id, project_id, db)
        # 已完成（含全班已完成）則冪等回傳既有時間戳，不再寫入
        if student.completed_at is None and project.completed_at is None:
            _assert_student_content_filled(project, student)
            student.completed_at = utc_now()
            if all(
                sibling.completed_at is not None for sibling in project.students
            ):
                project.completed_at = student.completed_at
            db.commit()
        return {
            "ok": True,
            "completed_at": student.completed_at,
            "project_completed_at": project.completed_at,
        }


def reopen_project_student(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
) -> dict:
    """由主管或管理員退回單一學生完成；全班完成已成立時一併解除，其他學生保留。"""
    project = get_project_or_404(project_id, db)
    assert_project_completion_revertible(project, current_user, db)
    get_student_or_404(student_id, project_id, db)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_completion_revertible(project, current_user, db)
        student = get_student_or_404(student_id, project_id, db)
        student.completed_at = None
        project.completed_at = None
        db.commit()
        return {"ok": True}
