"""專案建立、改名、封存、復原與完成狀態 use cases。"""

import logging
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404
from database import Project, Template, User, utc_now
from services.project_access_service import (
    assert_project_completion_revertible,
    assert_project_writable,
)
from services.project_archive_service import purge_expired_archived_projects
from services.storage_factory import get_storage
from services.student_render_service import clear_student_render_outputs
from services.template_sync_locks import lock_project_content_writes, lock_template_write


PROJECT_ARCHIVE_DAYS = 30
logger = logging.getLogger(__name__)


def _clear_student_outputs_best_effort(
    storage,
    project_id: int,
    project_name: str,
    student_name: str,
    output_filename: str | None,
) -> None:
    """改名已提交後，輸出清理失敗只記錄，不改寫成功回應。"""
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


def create_project(
    db: Session,
    current_user: User,
    *,
    name: str,
    template_id: int,
    department: str | None,
    template_period_id: int | None,
) -> dict:
    """以模板最新 revision 建立專案。"""
    with lock_template_write(template_id):
        db.rollback()
        db.expire_all()
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
            template_revision=template.revision,
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


def rename_project(db: Session, current_user: User, project_id: int, name: str) -> dict:
    """改名並在 commit 後、仍持有 P 鎖時 best-effort 清除舊輸出。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    with lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_writable(project, current_user)
        normalized_name = name.strip()
        if project.name == normalized_name:
            db.rollback()
            return {"ok": True}

        previous_name = project.name
        output_states = [
            (student.name, student.output_filename)
            for student in project.students
        ]
        project.name = normalized_name
        project.updated_at = utc_now()
        for student in project.students:
            student.output_filename = None
        db.commit()

        storage = get_storage()
        for student_name, output_filename in output_states:
            _clear_student_outputs_best_effort(
                storage,
                project_id,
                previous_name,
                student_name,
                output_filename,
            )
    return {"ok": True}


def archive_project(db: Session, current_user: User, project_id: int) -> dict:
    """封存專案並設定復原期限。"""
    project = get_project_or_404(project_id, db)
    assert_project_writable(project, current_user)
    with lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_writable(project, current_user)
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
    assert_project_writable(project, current_user)
    expired_at_lock = False
    now = None
    with lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db, include_archived=True)
        assert_project_writable(project, current_user)
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
    assert_project_writable(project, current_user)
    with lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_writable(project, current_user)
        if not project.students:
            raise HTTPException(status_code=400, detail="尚無學生，無法標記全班完成")
        if project.completed_at is None:
            project.completed_at = utc_now()
            db.commit()
        return {"ok": True, "completed_at": project.completed_at}


def reopen_project(db: Session, current_user: User, project_id: int) -> dict:
    """由主管或管理員退回完成狀態。"""
    project = get_project_or_404(project_id, db)
    assert_project_completion_revertible(project, current_user, db)
    with lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_completion_revertible(project, current_user, db)
        project.completed_at = None
        db.commit()
        return {"ok": True}
