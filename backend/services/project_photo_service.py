"""專案照片讀寫、批次展開與 mapping use cases。"""

import json
import threading
from _thread import LockType
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import quote

from fastapi import HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from crud.project_crud import get_project_or_404, get_student_or_404
from database import Project, ProjectStudent, User, utc_now
from services.file_service import (
    PHOTO_THUMBNAIL_SIZE,
    ProcessedImageUpload,
    build_photo_thumbnail_jpeg,
    get_photo_thumbnail_key,
    read_and_process_photo_upload,
)
from services.layout_group_traversal import iter_layout_render_elements
from services.project_access_service import (
    assert_project_content_writable,
    assert_project_readable,
    assert_student_content_writable,
    student_effectively_completed,
)
from services.project_template_revision import lock_project_template_revision
from services.request_limiter import photo_upload_limiter
from services.storage_factory import get_storage
from services.student_pages import (
    apply_photo_mapping,
    apply_photo_to_page,
    coerce_page_index_for_write,
    mutate_student_pages,
    page_has_photo,
    parse_pages_data,
    photo_record_key,
)


PHOTO_THUMBNAIL_HEADERS = {"Cache-Control": "private, max-age=86400"}
_thumbnail_build_locks: dict[str, LockType] = {}
_thumbnail_build_lock_users: dict[str, int] = {}
_thumbnail_build_locks_guard = threading.Lock()


@contextmanager
def _lock_thumbnail_build(thumbnail_key: str):
    """同一縮圖 key 只允許一個 cache-miss builder，完成後移除 lock。"""
    with _thumbnail_build_locks_guard:
        build_lock = _thumbnail_build_locks.setdefault(
            thumbnail_key,
            threading.Lock(),
        )
        _thumbnail_build_lock_users[thumbnail_key] = (
            _thumbnail_build_lock_users.get(thumbnail_key, 0) + 1
        )
    build_lock.acquire()
    try:
        yield
    finally:
        build_lock.release()
        with _thumbnail_build_locks_guard:
            remaining_users = _thumbnail_build_lock_users[thumbnail_key] - 1
            if remaining_users == 0:
                _thumbnail_build_lock_users.pop(thumbnail_key, None)
                if _thumbnail_build_locks.get(thumbnail_key) is build_lock:
                    _thumbnail_build_locks.pop(thumbnail_key, None)
            else:
                _thumbnail_build_lock_users[thumbnail_key] = remaining_users


@dataclass(frozen=True)
class SharedPhotoUploadOutcome:
    updated: int
    filename: str
    compressed: bool
    # 套用全班時被自動排除的已完成學生 id（回應必須揭露，不得靜默少套）
    skipped_completed_student_ids: tuple[int, ...] = ()


@dataclass(frozen=True)
class BatchPhotoUploadOutcome:
    succeeded: list[dict]
    failed: list[dict]
    skipped: list[dict]


@dataclass(frozen=True)
class StudentPhotoUploadIdentity:
    student_id: int
    project_id: int
    created_at: datetime


def _capture_student_photo_upload_identity(
    student: ProjectStudent,
) -> StudentPhotoUploadIdentity:
    return StudentPhotoUploadIdentity(
        student_id=student.id,
        project_id=student.project_id,
        created_at=student.created_at,
    )


def _get_current_student_for_photo_upload(
    db: Session,
    identity: StudentPhotoUploadIdentity,
) -> ProjectStudent:
    student = (
        db.query(ProjectStudent)
        .filter(
            ProjectStudent.id == identity.student_id,
            ProjectStudent.project_id == identity.project_id,
            ProjectStudent.created_at == identity.created_at,
        )
        .one_or_none()
    )
    if student is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "student_photo_target_changed",
                "message": "學生名單已變更，請重新整理後再上傳照片。",
                "student_id": identity.student_id,
            },
        )
    return student


def _parse_shared_student_ids(raw_student_ids: str | None) -> set[int] | None:
    """解析共用照片的目標學生 id 清單；None 表示套用全班。"""
    if raw_student_ids is None:
        return None
    try:
        student_ids = json.loads(raw_student_ids)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="student_ids 必須是合法 JSON")
    if (
        not isinstance(student_ids, list)
        or not student_ids
        or not all(
            isinstance(student_id, int) and not isinstance(student_id, bool)
            for student_id in student_ids
        )
    ):
        raise HTTPException(status_code=400, detail="student_ids 必須是非空的學生 id 陣列")
    return set(student_ids)


def _parse_layout(raw_layout: str) -> dict:
    try:
        return json.loads(raw_layout)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(
            status_code=422,
            detail="資料庫中的 layout_json JSON 格式損壞，請聯絡管理員",
        )


def _assert_project_photo_slot_exists(
    project: Project,
    page_index: int,
    slot_id: int,
) -> None:
    if page_index < 0 or page_index >= len(project.template.pages):
        raise HTTPException(status_code=404, detail="找不到頁面")

    template_page = project.template.pages[page_index]
    layout = _parse_layout(template_page.layout_json)
    visible_photo_slots = (
        element
        for element_type, element, _ in iter_layout_render_elements(layout)
        if element_type == "photo"
    )
    if not any(str(slot.get("id")) == str(slot_id) for slot in visible_photo_slots):
        raise HTTPException(status_code=404, detail="找不到照片格")


def _get_photo_key_or_404(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
) -> str:
    project = get_project_or_404(project_id, db)
    assert_project_readable(project, current_user, db)
    student = get_student_or_404(student_id, project_id, db)

    pages_data = parse_pages_data(student.pages_data_json)
    if page_index < 0 or page_index >= len(pages_data):
        raise HTTPException(status_code=404, detail="找不到頁面")

    photo_record = pages_data[page_index].get("photos", {}).get(str(slot_id))
    photo_key = photo_record_key(photo_record)
    if not photo_key:
        raise HTTPException(status_code=404, detail="找不到照片")

    if not get_storage().exists(photo_key):
        raise HTTPException(status_code=404, detail="找不到照片")
    return photo_key


def _validate_photo_mapping(
    project: Project,
    student: ProjectStudent,
    pages_data: list,
    mapping: dict,
) -> dict:
    allowed_prefix = f"projects/proj{project.id}/photos/student{student.id}/"
    existing_paths = {
        photo_record_key(record)
        for page_data in pages_data
        for record in (page_data.get("photos") or {}).values()
        if photo_record_key(record)
    }
    validated_mapping = {}
    for page_index_text, slot_updates in mapping.items():
        page_index = coerce_page_index_for_write(
            page_index_text,
            field="照片頁面索引",
        )
        if str(page_index) in validated_mapping:
            raise HTTPException(status_code=422, detail="照片頁面索引重複")
        validated_slots = {}
        for slot_id_text, slot_value in slot_updates.items():
            try:
                slot_id = int(slot_id_text)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="照片格位格式錯誤")
            _assert_project_photo_slot_exists(project, page_index, slot_id)
            if slot_value is None:
                validated_slots[str(slot_id)] = None
                continue
            photo_value = slot_value.model_dump()
            photo_path = photo_value["path"]
            if not photo_path.startswith(allowed_prefix) or photo_path not in existing_paths:
                raise HTTPException(status_code=400, detail="照片路徑不屬於目前學生")
            validated_slots[str(slot_id)] = photo_value
        validated_mapping[str(page_index)] = validated_slots
    return validated_mapping


async def upload_student_photo(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    expected_template_revision: int,
    file: UploadFile,
) -> str:
    """解碼鎖外、T→P→S 內寫 Storage 與 pages_data，回傳新 key。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    student = get_student_or_404(student_id, project_id, db)
    assert_student_content_writable(project, student, current_user)
    student_identity = _capture_student_photo_upload_identity(student)
    del student
    processed_upload = await read_and_process_photo_upload(file)
    storage = get_storage()
    now = utc_now()

    def write_photo() -> str:
        with lock_project_template_revision(db, project, expected_template_revision):
            assert_project_content_writable(project, current_user)
            current_student = _get_current_student_for_photo_upload(
                db,
                student_identity,
            )
            assert_student_content_writable(project, current_student, current_user)
            _assert_project_photo_slot_exists(project, page_index, slot_id)

            def mutate(pages_data) -> str:
                key = apply_photo_to_page(
                    pages_data,
                    current_student,
                    project_id,
                    page_index,
                    slot_id,
                    processed_upload,
                    storage,
                    now,
                )
                project.updated_at = now
                return key

            return mutate_student_pages(
                db,
                current_student,
                mutate,
                page_indices=[page_index],
                template_page_count=len(project.template.pages),
            )

    return await run_in_threadpool(write_photo)


async def upload_shared_project_photo(
    db: Session,
    current_user: User,
    project_id: int,
    page_index: int,
    slot_id: int,
    expected_template_revision: int,
    file: UploadFile,
    student_ids: str | None = None,
) -> SharedPhotoUploadOutcome:
    """逐學生 commit 共用照片；任一非預期失敗維持既有的停止展開語意。

    student_ids（JSON 陣列字串）可選：只套用到指定學生；未給則套用全班。
    """
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    target_student_ids = _parse_shared_student_ids(student_ids)
    processed_upload = await read_and_process_photo_upload(file)
    storage = get_storage()
    now = utc_now()

    def fanout_to_target_students() -> tuple[int, tuple[int, ...]]:
        with lock_project_template_revision(db, project, expected_template_revision):
            assert_project_content_writable(project, current_user)
            _assert_project_photo_slot_exists(project, page_index, slot_id)
            # 目標學生清單在鎖內決定，確保與 pages_data 寫入看到同一份名冊
            skipped_completed_student_ids: tuple[int, ...] = ()
            if target_student_ids is None:
                target_students = list(project.students)
                # 套用全班：鎖內自動排除已完成學生，並在回應揭露
                if current_user.role != "admin":
                    skipped_completed_student_ids = tuple(
                        student.id
                        for student in target_students
                        if student_effectively_completed(project, student)
                    )
                    target_students = [
                        student
                        for student in target_students
                        if not student_effectively_completed(project, student)
                    ]
            else:
                known_ids = {student.id for student in project.students}
                missing_ids = target_student_ids - known_ids
                if missing_ids:
                    raise HTTPException(
                        status_code=422,
                        detail="student_ids 含不屬於此專案的學生",
                    )
                target_students = [
                    student
                    for student in project.students
                    if student.id in target_student_ids
                ]
                # 指定名單含已完成學生 → 整批拒絕
                if current_user.role != "admin":
                    completed_target_names = [
                        student.name
                        for student in target_students
                        if student_effectively_completed(project, student)
                    ]
                    if completed_target_names:
                        raise HTTPException(
                            status_code=422,
                            detail={
                                "code": "shared_photo_targets_completed_students",
                                "message": "指定名單包含已完成學生，需主管先退回才能套用",
                                "completed_student_names": completed_target_names,
                            },
                        )
            count = 0
            first_key: str | None = None
            project.updated_at = now
            for student in target_students:
                key = mutate_student_pages(
                    db,
                    student,
                    lambda pages_data, student=student: apply_photo_to_page(
                        pages_data,
                        student,
                        project_id,
                        page_index,
                        slot_id,
                        processed_upload,
                        storage,
                        now,
                        source_key=first_key,
                    ),
                    page_indices=[page_index],
                    template_page_count=len(project.template.pages),
                )
                if first_key is None:
                    first_key = key
                count += 1
            return count, skipped_completed_student_ids

    updated, skipped_completed_student_ids = await run_in_threadpool(
        fanout_to_target_students
    )
    return SharedPhotoUploadOutcome(
        updated=updated,
        filename=processed_upload.filename,
        compressed=processed_upload.compressed,
        skipped_completed_student_ids=skipped_completed_student_ids,
    )


def _parse_batch_mapping(mapping: str) -> dict[str, str]:
    try:
        mapping_data = json.loads(mapping)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="mapping 必須是合法 JSON")
    if not isinstance(mapping_data, dict):
        raise HTTPException(status_code=400, detail="mapping 必須是 student_id→filename 字典")
    return mapping_data


async def batch_upload_project_photos(
    db: Session,
    current_user: User,
    project_id: int,
    page_index: int,
    slot_id: int,
    expected_template_revision: int,
    files: list[UploadFile],
    mapping: str,
    overwrite_existing: bool,
) -> BatchPhotoUploadOutcome:
    """鎖外解碼批次照片，鎖內逐學生 commit 並維持 partial-success。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    mapping_data = _parse_batch_mapping(mapping)
    files_by_name = {file.filename: file for file in files}
    student_identities_by_id = {
        str(student_id): StudentPhotoUploadIdentity(
            student_id=student_id,
            project_id=identity_project_id,
            created_at=student_created_at,
        )
        for student_id, identity_project_id, student_created_at in (
            db.query(ProjectStudent.id, ProjectStudent.project_id, ProjectStudent.created_at)
            .filter(ProjectStudent.project_id == project_id)
            .all()
        )
    }
    storage = get_storage()
    now = utc_now()
    failed: list[dict] = []
    prepared_assignments: list[
        tuple[StudentPhotoUploadIdentity, str, ProcessedImageUpload]
    ] = []

    for student_id_text, filename in mapping_data.items():
        if student_id_text not in student_identities_by_id:
            failed.append(
                {
                    "student_id": int(student_id_text) if student_id_text.isdigit() else -1,
                    "filename": filename or "",
                    "reason": "student_not_in_project",
                }
            )
            continue
        student_identity = student_identities_by_id[student_id_text]
        upload_file = files_by_name.get(filename)
        if upload_file is None:
            failed.append(
                {
                    "student_id": student_identity.student_id,
                    "filename": filename or "",
                    "reason": "file_not_uploaded",
                }
            )
            continue
        try:
            processed_upload = await read_and_process_photo_upload(upload_file)
        except HTTPException as exc:
            failed.append(
                {
                    "student_id": student_identity.student_id,
                    "filename": filename,
                    "reason": f"upload_rejected:{exc.detail}",
                }
            )
            continue
        except Exception:
            failed.append(
                {
                    "student_id": student_identity.student_id,
                    "filename": filename,
                    "reason": "image_decode_failed",
                }
            )
            continue
        prepared_assignments.append((student_identity, filename, processed_upload))

    def write_batch() -> tuple[list[dict], list[dict]]:
        succeeded: list[dict] = []
        skipped: list[dict] = []
        with lock_project_template_revision(db, project, expected_template_revision):
            assert_project_content_writable(project, current_user)
            current_students_by_id = {
                identity.student_id: _get_current_student_for_photo_upload(db, identity)
                for identity, _, _ in prepared_assignments
            }
            _assert_project_photo_slot_exists(project, page_index, slot_id)
            for student_identity, filename, processed_upload in prepared_assignments:
                student = current_students_by_id[student_identity.student_id]
                # 已完成學生不接受批次照片，維持逐學生 partial-success 契約
                if current_user.role != "admin" and student_effectively_completed(
                    project, student
                ):
                    failed.append(
                        {
                            "student_id": student.id,
                            "filename": filename,
                            "reason": "student_completed_locked",
                        }
                    )
                    continue

                def mutate(pages_data) -> str | None:
                    if not overwrite_existing and page_has_photo(
                        pages_data,
                        page_index,
                        slot_id,
                    ):
                        return None
                    key = apply_photo_to_page(
                        pages_data,
                        student,
                        project_id,
                        page_index,
                        slot_id,
                        processed_upload,
                        storage,
                        now,
                    )
                    project.updated_at = now
                    return key

                try:
                    key = mutate_student_pages(
                        db,
                        student,
                        mutate,
                        page_indices=[page_index],
                        template_page_count=len(project.template.pages),
                    )
                except Exception:
                    failed.append(
                        {
                            "student_id": student.id,
                            "filename": filename,
                            "reason": "storage_write_failed",
                        }
                    )
                    continue
                if key is None:
                    skipped.append(
                        {
                            "student_id": student.id,
                            "filename": filename,
                            "reason": "already_has_photo",
                        }
                    )
                    continue
                succeeded.append(
                    {"student_id": student.id, "filename": filename, "path": key}
                )
        return succeeded, skipped

    succeeded, skipped = await run_in_threadpool(write_batch)
    return BatchPhotoUploadOutcome(
        succeeded=succeeded,
        failed=failed,
        skipped=skipped,
    )


def update_student_photo_mapping(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    pages: dict,
    expected_template_revision: int,
) -> None:
    """以 T→P→S 鎖更新 mapping，維持先寫後清與實體檔案 cleanup 順序。"""
    project = get_project_or_404(project_id, db)
    assert_project_content_writable(project, current_user)
    with lock_project_template_revision(db, project, expected_template_revision):
        assert_project_content_writable(project, current_user)
        student = get_student_or_404(student_id, project_id, db)
        assert_student_content_writable(project, student, current_user)
        storage = get_storage()

        def mutate(pages_data) -> None:
            validated_mapping = _validate_photo_mapping(project, student, pages_data, pages)
            apply_photo_mapping(pages_data, validated_mapping, storage)
            now = utc_now()
            student.updated_at = now
            project.updated_at = now

        mutate_student_pages(
            db,
            student,
            mutate,
            page_indices=pages,
            template_page_count=len(project.template.pages),
        )


def serve_student_photo(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
):
    photo_key = _get_photo_key_or_404(
        db,
        current_user,
        project_id,
        student_id,
        page_index,
        slot_id,
    )
    return get_storage().serve(photo_key)


def serve_student_photo_thumbnail(
    db: Session,
    current_user: User,
    project_id: int,
    student_id: int,
    page_index: int,
    slot_id: int,
    size: int = PHOTO_THUMBNAIL_SIZE,
) -> Response:
    photo_key = _get_photo_key_or_404(
        db,
        current_user,
        project_id,
        student_id,
        page_index,
        slot_id,
    )
    storage = get_storage()
    thumbnail_key = get_photo_thumbnail_key(photo_key, size)
    headers = {
        **PHOTO_THUMBNAIL_HEADERS,
        "X-Photo-Thumbnail-Key": quote(thumbnail_key, safe="/"),
    }

    def cached_response() -> Response:
        return Response(
            content=storage.get_bytes(thumbnail_key),
            media_type="image/jpeg",
            headers={**headers, "X-Photo-Thumbnail": "HIT"},
        )

    try:
        return cached_response()
    except FileNotFoundError:
        pass

    with _lock_thumbnail_build(thumbnail_key):
        try:
            return cached_response()
        except FileNotFoundError:
            pass

        with photo_upload_limiter.acquire("照片縮圖處理中，請稍後再試"):
            thumbnail_bytes = build_photo_thumbnail_jpeg(
                storage,
                photo_key,
                size,
            )
            try:
                storage.put(thumbnail_key, thumbnail_bytes)
            except Exception:
                pass
        return Response(
            content=thumbnail_bytes,
            media_type="image/jpeg",
            headers={**headers, "X-Photo-Thumbnail": "MISS"},
        )
