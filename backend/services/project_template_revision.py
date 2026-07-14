"""專案內容寫入的模板版本 compare-and-swap guard。"""

from contextlib import contextmanager

from fastapi import HTTPException

from services.template_sync_locks import lock_project_content_writes, lock_template_write


@contextmanager
def lock_project_template_revision(db, project, expected_template_revision: int):
    """固定依 template→project 順序加鎖，確認頁碼語意仍是前端載入的版本。"""
    with lock_template_write(project.template_id):
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
