"""相本學生快照的相本稱呼與頁面 use cases。"""

import logging

from sqlalchemy.orm import Session

from crud.project_crud import get_project_or_404, get_student_or_404
from database import Student, User, utc_now
from services.organization_lock import organization_acl_lock
from services.project_access_service import assert_project_content_writable
from services.project_template_revision import lock_project_template_revision
from services.storage_factory import get_storage
from services.student_album_name_policy import assign_automatic_album_names
from services.student_pages import (
    ensure_page_entry,
    lock_student_page_writes,
    mutate_student_pages,
)
from services.student_input_policy import normalize_student_album_name
from services.student_render_service import clear_student_render_outputs
from services.template_sync_locks import lock_project_content_writes


logger = logging.getLogger(__name__)


def _effective_album_name_for_collision(student: Student) -> str:
    """碰撞檢查時讓舊資料的空白稱呼回退完整姓名。"""
    album_name = str(student.album_name) if student.album_name is not None else ""
    return album_name if album_name.strip() else str(student.name)


def _clear_student_outputs_best_effort(
    storage,
    project_id: int,
    student_id: int,
    student_name: str,
    output_filename: str | None,
    protected_output_filenames: tuple[str, ...] = (),
) -> None:
    """DB mutation 已提交後，輸出清理失敗只留紀錄，不把成功操作偽裝成失敗。"""
    try:
        clear_student_render_outputs(
            storage,
            project_id,
            student_id,
            output_filename,
            protected_output_filenames,
        )
    except Exception:
        logger.exception(
            "學生輸出清理失敗 project_id=%s student_id=%s student_name=%s",
            project_id,
            student_id,
            student_name,
        )


def auto_fill_student_album_names(
    db: Session,
    current_user: User,
    project_id: int,
) -> dict:
    """P→S 鎖內為既有學生批次補上可安全推導的相本稱呼。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_content_writable(project, current_user)
        eligible_student_ids = [
            student.id
            for student in project.students
            if not student.album_name or not student.album_name.strip()
        ]
        with lock_student_page_writes(eligible_student_ids):
            db.rollback()
            db.expire_all()
            project = get_project_or_404(project_id, db)
            assert_project_content_writable(project, current_user)
            eligible_students = [
                student
                for student in project.students
                if not student.album_name or not student.album_name.strip()
            ]
            protected_effective_names = [
                student.effective_album_name
                for student in project.students
                if student.album_name and student.album_name.strip()
            ]
            album_names = assign_automatic_album_names(
                [student.name for student in eligible_students],
                protected_effective_names,
            )
            updated_students = [
                (student, album_name)
                for student, album_name in zip(
                    eligible_students,
                    album_names,
                    strict=True,
                )
                if album_name is not None
            ]
            unresolved_count = len(eligible_students) - len(updated_students)
            if not updated_students:
                db.rollback()
                return {"updated": 0, "unresolved": unresolved_count}

            updated_student_ids = {
                student.id for student, _album_name in updated_students
            }
            protected_output_filenames = tuple(
                student.output_filename
                for student in project.students
                if (
                    student.id not in updated_student_ids
                    and student.output_filename
                )
            )
            output_states = [
                (student.id, student.name, student.output_filename)
                for student, _album_name in updated_students
            ]
            now = utc_now()
            for student, album_name in updated_students:
                student.album_name = album_name
                student.output_filename = None
                student.updated_at = now
            project.updated_at = now
            db.commit()

            try:
                storage = get_storage()
            except Exception:
                logger.exception("學生批次輸出清理初始化失敗 project_id=%s", project_id)
            else:
                for student_id, student_name, output_filename in output_states:
                    _clear_student_outputs_best_effort(
                        storage,
                        project_id,
                        student_id,
                        student_name,
                        output_filename,
                        protected_output_filenames,
                    )
            return {
                "updated": len(updated_students),
                "unresolved": unresolved_count,
            }


def auto_fill_student_album_name(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
) -> dict:
    """P→S 鎖內只為指定學生補上可安全推導的相本稱呼。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    get_student_or_404(student_id, project_id, db)
    with organization_acl_lock, lock_project_content_writes([project_id]):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_content_writable(project, current_user)
        get_student_or_404(student_id, project_id, db)
        with lock_student_page_writes([student_id]):
            db.rollback()
            db.expire_all()
            project = get_project_or_404(project_id, db)
            assert_project_content_writable(project, current_user)
            student = get_student_or_404(student_id, project_id, db)
            if student.album_name and student.album_name.strip():
                db.rollback()
                return {"updated": 0, "unresolved": 0}

            album_name = assign_automatic_album_names(
                [str(student.name)],
                [
                    _effective_album_name_for_collision(sibling)
                    for sibling in project.students
                    if sibling.id != student_id
                ],
            )[0]
            if album_name is None:
                db.rollback()
                return {"updated": 0, "unresolved": 1}

            protected_output_filenames = tuple(
                sibling.output_filename
                for sibling in project.students
                if sibling.id != student_id and sibling.output_filename
            )
            previous_name = student.name
            previous_output_filename = student.output_filename
            now = utc_now()
            student.album_name = album_name
            student.output_filename = None
            student.updated_at = now
            project.updated_at = now
            db.commit()

            try:
                storage = get_storage()
            except Exception:
                logger.exception(
                    "學生單筆輸出清理初始化失敗 project_id=%s student_id=%s",
                    project_id,
                    student_id,
                )
            else:
                _clear_student_outputs_best_effort(
                    storage,
                    project_id,
                    student_id,
                    previous_name,
                    previous_output_filename,
                    protected_output_filenames,
                )
            return {"updated": 1, "unresolved": 0}


def update_student_album_name(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    album_name: str | None,
) -> dict:
    """P→S 鎖內只更新相本稱呼，學生完整姓名保持快照不變。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    get_student_or_404(student_id, project_id, db)
    normalized_album_name = normalize_student_album_name(album_name)
    with (
        organization_acl_lock,
        lock_project_content_writes([project_id]),
        lock_student_page_writes([student_id]),
    ):
        db.rollback()
        db.expire_all()
        project = get_project_or_404(project_id, db)
        assert_project_content_writable(project, current_user)
        student = get_student_or_404(student_id, project_id, db)
        if student.album_name == normalized_album_name:
            result = _serialize_student_identity(student)
            db.rollback()
            return result

        previous_name = student.name
        previous_output_filename = student.output_filename
        protected_output_filenames = tuple(
            sibling.output_filename
            for sibling in project.students
            if sibling.id != student_id and sibling.output_filename
        )
        now = utc_now()
        student.album_name = normalized_album_name
        student.output_filename = None
        student.updated_at = now
        project.updated_at = now
        result = _serialize_student_identity(student)
        db.commit()

        _clear_student_outputs_best_effort(
            get_storage(),
            project_id,
            student_id,
            previous_name,
            previous_output_filename,
            protected_output_filenames,
        )
    return result


def _serialize_student_identity(student: Student) -> dict:
    """學生更新端點的穩定回應契約。"""
    return {
        "ok": True,
        "name": student.name,
        "album_name": student.album_name,
        "effective_album_name": student.effective_album_name,
    }


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

        mutate_student_pages(
            db,
            student,
            _mutate,
            page_indices=[page_index],
            template_page_count=len(project.template.pages),
        )
    return {"ok": True}
