"""專案內容寫入的模板版本 compare-and-swap guard。"""

from contextlib import contextmanager

from fastapi import HTTPException

from services.organization_lock import organization_acl_lock
from services.template_sync_locks import lock_project_content_writes, lock_template_write


@contextmanager
def lock_project_template_revision(db, project, expected_template_revision: int):
    """依 organization→template→project 加鎖，重驗 ACL 所需最新狀態。"""
    with organization_acl_lock, lock_template_write(project.template_id):
        with lock_project_content_writes([project.id]):
            # API dependency 的權限查詢已可能開啟 WAL read snapshot；等待鎖後
            # 必須結束它，CAS 才會讀到鎖內最新 revision／內容。
            db.rollback()
            db.expire_all()
            db.refresh(project)
            template = project.template
            db.refresh(template)
            if (
                expected_template_revision != project.template_revision
                or expected_template_revision != template.revision
            ):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "project_template_revision_changed",
                        "message": "模板已更新，請重新載入專案後再編輯。",
                        "expected_template_revision": expected_template_revision,
                        "project_template_revision": project.template_revision,
                        "template_revision": template.revision,
                    },
                )
            yield project
