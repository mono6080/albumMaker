"""專案學生名單、改名、刪除與跳頁 use cases。"""

import logging

from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404, get_student_or_404
from database import Student, User, utc_now
from services.project_access_service import (
    assert_project_content_writable,
    assert_project_readable,
)
from services.project_template_revision import lock_project_template_revision
from services.roster_identity_service import (
    delete_roster_child_if_orphaned,
    resolve_roster_child_id,
)
from services.storage_factory import get_storage
from services.student_pages import (
    ensure_page_entry,
    lock_student_page_writes,
    mutate_student_pages,
)
from services.student_render_service import clear_student_render_outputs
from services.template_sync_locks import lock_project_content_writes


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


def batch_add_students(
    db: Session,
    current_user: User,
    project_id: int,
    names: list[str],
) -> dict:
    """批次新增學生；P 鎖內重查並以單次 transaction 提交。"""
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
            default=-1,
        ) + 1

        for raw_name in names:
            student_name = raw_name.strip()
            if not student_name:
                continue
            if student_name in existing_names or student_name in names_seen_in_batch:
                skipped_names.append(student_name)
                continue

            names_seen_in_batch.add(student_name)
            db.add(Student(
                project_id=project_id,
                name=student_name,
                order_index=next_order_index,
                pages_data_json="[]",
                roster_child_id=resolve_roster_child_id(db, student_name),
            ))
            created_names.append(student_name)
            next_order_index += 1

        db.commit()
        return {"created": created_names, "skipped": skipped_names}


def copy_students_from_project(
    db: Session,
    current_user: User,
    project_id: int,
    source_project_id: int,
) -> dict:
    """跨專案複製學生與既有 roster identity。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    source_project = get_project_or_404(source_project_id, db)
    assert_project_readable(source_project, current_user, db)
    with lock_project_content_writes([project_id, source_project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_content_writable(project, current_user)
        source_project = get_project_or_404(source_project_id, db)
        assert_project_readable(source_project, current_user, db)

        existing_names = {student.name for student in project.students}
        created_names = []
        skipped_names = []
        next_order_index = max(
            (student.order_index for student in project.students),
            default=-1,
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


def update_student(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    name: str | None,
) -> dict:
    """P→S 鎖內改名、提交並 best-effort 清舊輸出。"""
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


def delete_student(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
) -> dict:
    """P→S 鎖內刪除 DB，再清輸出與照片 namespace。"""
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
        # 保持 P 鎖到舊照片 namespace 清除完成，避免 student id 重用誤刪新資料。
        _delete_storage_prefix_best_effort(
            storage,
            f"projects/proj{project_id}/photos/student{student_id}",
        )
    return {"ok": True}


def set_page_skip(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    page_index: int,
    skip: bool,
    expected_template_revision: int,
) -> dict:
    """T→P→S 契約下更新學生頁面 skip。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    with lock_project_template_revision(db, project, expected_template_revision):
        assert_project_content_writable(project, current_user)
        student = get_student_or_404(student_id, project_id, db)

        def _mutate(pages_data) -> None:
            ensure_page_entry(pages_data, page_index)["skip"] = skip

        mutate_student_pages(db, student, _mutate)
    return {"ok": True}
