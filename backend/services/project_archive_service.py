import logging
from datetime import datetime

from database import Project, utc_now
from services.storage_factory import get_storage
from services.template_sync_locks import lock_project_content_writes


logger = logging.getLogger(__name__)


def purge_expired_archived_projects(db, now: datetime | None = None) -> list[int]:
    """刪除超過復原期限的專案與整個 storage namespace。"""
    cutoff = now or utc_now()
    expired_project_ids = [
        project_id
        for (project_id,) in (
            db.query(Project.id)
            .filter(
                Project.deleted_at.isnot(None),
                Project.archive_expires_at.isnot(None),
                Project.archive_expires_at <= cutoff,
            )
            .all()
        )
    ]
    if not expired_project_ids:
        return []

    with lock_project_content_writes(expired_project_ids):
        db.rollback()
        db.expire_all()
        expired_projects = (
            db.query(Project)
            .filter(
                Project.id.in_(expired_project_ids),
                Project.deleted_at.isnot(None),
                Project.archive_expires_at.isnot(None),
                Project.archive_expires_at <= cutoff,
            )
            .all()
        )
        storage = get_storage()
        purged_project_ids = []
        for project in expired_projects:
            try:
                storage.delete_prefix(f"projects/proj{project.id}")
            except Exception as storage_error:
                logger.error(
                    "過期專案 storage 清理失敗 project_id=%s: %s",
                    project.id,
                    storage_error,
                )
                continue
            purged_project_ids.append(project.id)
            db.delete(project)
        if purged_project_ids:
            db.commit()
            logger.info("已清理過期封存專案 project_ids=%s", purged_project_ids)
    return purged_project_ids
