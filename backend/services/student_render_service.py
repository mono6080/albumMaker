import hashlib
import json
import logging
import threading
from contextlib import contextmanager
from pathlib import Path
from pathlib import PurePosixPath

from fastapi import HTTPException

from database import Project, Student, User
from services.draw_helpers import BUNDLED_FONT_MANIFEST_PATHS
from services.label_texts import merge_project_label_texts_into_pages
from services.layout_group_traversal import layout_for_render_fingerprint
from services.output_keys import (
    build_combined_stem,
    get_student_image_key,
    get_student_output_prefix,
    get_student_pdf_key,
    get_student_render_state_key,
    student_output_prefix_from_pdf_key,
    student_pdf_key_for_mode,
)
from services.organization_lock import organization_acl_lock
from services.project_access_service import assert_project_writable
from services.render_service import (
    PRINT_OUTPUT_SIZE,
    derive_screen_images,
    render_album,
    save_album_images,
    save_album_pdf,
)
from services.storage_factory import get_storage
from services.student_pages import lock_student_page_writes
from services.template_sync_locks import lock_project_content_writes
from services.text_variables import get_effective_album_name


logger = logging.getLogger(__name__)


def get_template_page_layouts(project: Project) -> list[dict]:
    """讀取模板頁面 layout，並注入渲染所需背景 key。"""
    page_layouts = []
    for template_page in project.template.pages:
        layout = json.loads(template_page.layout_json)
        layout["background_filename"] = template_page.background_filename
        page_layouts.append(layout)
    return page_layouts


_SERVICES_DIR = Path(__file__).resolve().parent


def _resolve_render_asset(paths: tuple[str, ...]) -> Path:
    """解析本機 public 或 Docker dist 內實際使用的渲染資產。"""
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_file():
            return path
    raise FileNotFoundError(f"找不到渲染資產：{paths}")


_RENDER_PIPELINE_FILES = (
    _SERVICES_DIR / "render_service.py",
    _SERVICES_DIR / "student_render_service.py",
    _SERVICES_DIR / "label_texts.py",
    _SERVICES_DIR / "layout_group_validation.py",
    _SERVICES_DIR / "layout_group_traversal.py",
    _SERVICES_DIR / "element_renderers.py",
    _SERVICES_DIR / "draw_helpers.py",
    _SERVICES_DIR / "render_image_loader.py",
    _SERVICES_DIR / "text_layout.py",
    _SERVICES_DIR / "text_variables.py",
    _SERVICES_DIR / "photo_frame_geometry.py",
    _SERVICES_DIR / "design_tokens.json",
    _resolve_render_asset(BUNDLED_FONT_MANIFEST_PATHS),
)


def _render_pipeline_fingerprint(paths: tuple[Path, ...] = _RENDER_PIPELINE_FILES) -> str:
    """由實際渲染來源自動推導版本，避免修改視覺邏輯卻忘記手動 bump。"""
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:20]


_RENDER_PIPELINE_VERSION = _render_pipeline_fingerprint()

_student_render_locks: dict[int, threading.Lock] = {}
_student_render_locks_guard = threading.Lock()


@contextmanager
def _lock_student_render(student_id: int):
    """同一位學生一次只允許一個完整渲染，避免較早開始的工作晚到覆蓋。"""
    with _student_render_locks_guard:
        render_lock = _student_render_locks.setdefault(student_id, threading.Lock())
    with render_lock:
        yield


def _clear_student_render_outputs(storage, student_output_prefix: str) -> None:
    """清除單一學生的 canonical namespace，不以姓名做 lexical prefix。"""
    storage.delete_prefix(student_output_prefix)


def _legacy_output_targets(output_filename: str) -> tuple[set[str], str] | None:
    """拆出舊版姓名 key 的 PDF 與圖片／狀態目錄；新版 key 不需此路徑。"""
    if student_output_prefix_from_pdf_key(output_filename) is not None:
        return None
    output_path = PurePosixPath(output_filename)
    return (
        {
            output_filename,
            student_pdf_key_for_mode(output_filename, "screen"),
        },
        str(output_path.with_suffix("")),
    )


def _clear_legacy_student_render_outputs(
    storage,
    output_filename: str | None,
    protected_output_filenames: tuple[str, ...] = (),
) -> None:
    """精確清舊版輸出；若 key 被其他學生引用則保留，避免 suffix／同名互刪。"""
    if not output_filename:
        return
    targets = _legacy_output_targets(output_filename)
    if targets is None:
        return
    pdf_keys, image_prefix = targets

    protected_pdf_keys: set[str] = set()
    protected_image_prefixes: set[str] = set()
    for protected_output_filename in protected_output_filenames:
        protected_targets = _legacy_output_targets(protected_output_filename)
        if protected_targets is None:
            continue
        protected_pdfs, protected_images = protected_targets
        protected_pdf_keys.update(protected_pdfs)
        protected_image_prefixes.add(protected_images)

    for pdf_key in pdf_keys - protected_pdf_keys:
        storage.delete(pdf_key)
    if image_prefix not in protected_image_prefixes:
        storage.delete_prefix(image_prefix)


def _student_render_outputs_complete(
    storage,
    *,
    project_id: int,
    student_id: int,
    page_count: int,
) -> bool:
    """dirty-skip 只有在兩份 PDF 與所有承諾頁圖都存在時才可沿用。"""
    print_key = get_student_pdf_key(project_id, student_id)
    screen_key = student_pdf_key_for_mode(print_key, "screen")
    if not storage.exists(print_key) or not storage.exists(screen_key):
        return False

    image_prefix = f"{get_student_output_prefix(project_id, student_id)}/images"
    existing_image_keys = set(storage.list_keys(image_prefix))
    expected_image_keys = {
        *(
            get_student_image_key(project_id, student_id, "print", page_number)
            for page_number in range(1, page_count + 1)
        ),
        *(
            get_student_image_key(project_id, student_id, "screen", page_number)
            for page_number in range(1, page_count + 1)
        ),
    }
    return expected_image_keys <= existing_image_keys


def clear_student_render_outputs(
    storage,
    project_id: int,
    student_id: int,
    output_filename: str | None,
    protected_output_filenames: tuple[str, ...] = (),
) -> None:
    """清 canonical ID namespace，並相容精確清理舊版姓名輸出。"""
    _clear_student_render_outputs(
        storage,
        get_student_output_prefix(project_id, student_id),
    )
    _clear_legacy_student_render_outputs(
        storage,
        output_filename,
        protected_output_filenames,
    )


def _album_render_hash(
    page_layouts: list[dict],
    student_name: str,
    student_pages_data: list,
    album_name: str | None = None,
) -> str:
    """渲染輸入的內容指紋。"""
    payload = json.dumps(
        {
            "pipeline": _RENDER_PIPELINE_VERSION,
            "layouts": [layout_for_render_fingerprint(layout) for layout in page_layouts],
            "full_name": student_name,
            "album_name": get_effective_album_name(student_name, album_name),
            "pages": student_pages_data,
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _assert_render_access(
    project: Project,
    actor_id: int | None,
    db,
) -> None:
    """渲染捕捉與發布都重驗封存狀態及目前組織權限。"""
    if project.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Project not found")
    if actor_id is None:
        return
    actor = db.get(User, actor_id)
    if actor is None:
        raise HTTPException(status_code=403, detail="無此專案的編輯權限")
    # 完成後仍須允許老師產生交件檔；渲染只重驗目前編制 ACL，不套內容鎖。
    assert_project_writable(project, actor, db)


def _capture_student_render_input(
    project_id: int,
    student_id: int,
    db,
    *,
    actor_id: int | None = None,
) -> dict:
    """在短鎖內取得同一版本的模板、專案文字與學生資料，慢渲染不持鎖。"""
    with (
        organization_acl_lock,
        lock_project_content_writes([project_id]),
        lock_student_page_writes([student_id]),
    ):
        db.rollback()
        db.expire_all()
        current_project = db.get(Project, project_id)
        current_student = db.get(Student, student_id)
        if current_project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        _assert_render_access(current_project, actor_id, db)
        if current_student is None or current_student.project_id != project_id:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "render_input_changed",
                    "message": "相本內容已變更，請重新產生。",
                },
            )

        page_layouts = get_template_page_layouts(current_project)
        if not page_layouts:
            raise HTTPException(status_code=400, detail="模板尚未建立任何頁面")

        project_label_texts_raw = current_project.label_texts_json or "{}"
        student_pages_data_raw = current_student.pages_data_json
        project_label_texts = json.loads(project_label_texts_raw)
        student_pages_data = merge_project_label_texts_into_pages(
            json.loads(student_pages_data_raw),
            project_label_texts,
            page_layouts,
        )
        template_revision = int(current_project.template_revision or 1)
        resolved_album_name = current_student.resolved_album_name
        render_input = {
            "project_name": current_project.name,
            "student_name": current_student.name,
            "album_name": resolved_album_name,
            "page_layouts": page_layouts,
            "student_pages_data": student_pages_data,
            "template_revision": template_revision,
            "state_token": (
                current_project.template_id,
                template_revision,
                int(current_project.template.revision or 1),
                current_project.created_at,
                current_project.deleted_at,
                current_project.classroom_id,
                current_student.created_at,
                current_student.roster_child_id,
                current_project.name,
                project_label_texts_raw,
                current_student.name,
                resolved_album_name,
                student_pages_data_raw,
            ),
        }
        db.rollback()
        return render_input


def _current_student_render_token(project_id: int, student_id: int, db) -> tuple | None:
    """publish 前重新讀取 CAS token。"""
    db.rollback()
    db.expire_all()
    current_project = db.get(Project, project_id)
    current_student = db.get(Student, student_id)
    if current_project is None or current_student is None or current_student.project_id != project_id:
        return None
    resolved_album_name = current_student.resolved_album_name
    return (
        current_project.template_id,
        int(current_project.template_revision or 1),
        int(current_project.template.revision or 1),
        current_project.created_at,
        current_project.deleted_at,
        current_project.classroom_id,
        current_student.created_at,
        current_student.roster_child_id,
        current_project.name,
        current_project.label_texts_json or "{}",
        current_student.name,
        resolved_album_name,
        current_student.pages_data_json,
    )


def _raise_render_input_changed(captured_revision: int, current_token: tuple | None) -> None:
    current_revision = current_token[1] if current_token is not None else None
    raise HTTPException(
        status_code=409,
        detail={
            "code": "render_input_changed",
            "message": "模板或相本內容已在產生期間更新，請重新產生。",
            "captured_revision": captured_revision,
            "current_revision": current_revision,
        },
    )


def render_and_save_student_album(
    project: Project,
    student: Student,
    project_id: int,
    db,
    *,
    actor_id: int | None = None,
) -> dict:
    """捕捉、渲染並以內容 CAS 發布單一學生相冊。"""
    del project
    student_id = student.id
    with _lock_student_render(student_id):
        render_input = _capture_student_render_input(
            project_id,
            student_id,
            db,
            actor_id=actor_id,
        )
        page_layouts = render_input["page_layouts"]
        student_name = render_input["student_name"]
        album_name = render_input["album_name"]
        student_pages_data = render_input["student_pages_data"]
        combined_stem = build_combined_stem(render_input["project_name"], student_name)
        student_output_prefix = get_student_output_prefix(project_id, student_id)
        print_key = get_student_pdf_key(project_id, student_id)
        screen_key = student_pdf_key_for_mode(print_key, "screen")
        render_hash_key = get_student_render_state_key(project_id, student_id)

        storage = get_storage()
        render_hash = _album_render_hash(
            page_layouts,
            student_name,
            student_pages_data,
            album_name,
        )
        data_map = {page.get("page_index"): page for page in student_pages_data}
        page_count = sum(1 for page_index in range(len(page_layouts)) if not data_map.get(page_index, {}).get("skip"))

        try:
            previous_hash = storage.get_bytes(render_hash_key).decode("utf-8").strip()
        except FileNotFoundError:
            previous_hash = None
        if (
            previous_hash == render_hash
            and _student_render_outputs_complete(
                storage,
                project_id=project_id,
                student_id=student_id,
                page_count=page_count,
            )
        ):
            with (
                organization_acl_lock,
                lock_project_content_writes([project_id]),
                lock_student_page_writes([student_id]),
            ):
                current_token = _current_student_render_token(project_id, student_id, db)
                current_project = db.get(Project, project_id)
                if current_project is None:
                    raise HTTPException(status_code=404, detail="Project not found")
                _assert_render_access(current_project, actor_id, db)
                if current_token != render_input["state_token"]:
                    _raise_render_input_changed(render_input["template_revision"], current_token)
                current_student = db.get(Student, student_id)
                assert current_student is not None
                previous_output_filename = current_student.output_filename
                protected_output_filenames = tuple(
                    sibling.output_filename
                    for sibling in current_project.students
                    if sibling.id != student_id and sibling.output_filename
                )
                if current_student.output_filename != print_key:
                    current_student.output_filename = print_key
                    db.commit()
                else:
                    db.rollback()
                try:
                    _clear_legacy_student_render_outputs(
                        storage,
                        previous_output_filename,
                        protected_output_filenames,
                    )
                except Exception:
                    logger.exception(
                        "舊版學生輸出清理失敗 project_id=%s student_id=%s",
                        project_id,
                        student_id,
                    )
            return {"pdf": print_key, "pages": page_count, "skipped": True}

        rendered_print_images = render_album(
            page_layouts,
            student_name,
            student_pages_data,
            output_size=PRINT_OUTPUT_SIZE,
            album_name=album_name,
        )
        rendered_screen_images = derive_screen_images(rendered_print_images)
        print_pdf_bytes = save_album_pdf(rendered_print_images, mode="print")
        screen_pdf_bytes = save_album_pdf(rendered_screen_images, mode="screen")
        print_image_bytes = save_album_images(rendered_print_images, combined_stem, mode="print")
        screen_image_bytes = save_album_images(rendered_screen_images, combined_stem, mode="screen")

        with (
            organization_acl_lock,
            lock_project_content_writes([project_id]),
            lock_student_page_writes([student_id]),
        ):
            current_token = _current_student_render_token(project_id, student_id, db)
            current_project = db.get(Project, project_id)
            if current_project is None:
                raise HTTPException(status_code=404, detail="Project not found")
            _assert_render_access(current_project, actor_id, db)
            if current_token != render_input["state_token"]:
                _raise_render_input_changed(render_input["template_revision"], current_token)

            current_student = db.get(Student, student_id)
            assert current_student is not None
            previous_output_filename = current_student.output_filename
            protected_output_filenames = tuple(
                sibling.output_filename
                for sibling in current_project.students
                if sibling.id != student_id and sibling.output_filename
            )

            _clear_student_render_outputs(storage, student_output_prefix)
            storage.put(print_key, print_pdf_bytes)
            storage.put(screen_key, screen_pdf_bytes)
            for page_number, image_bytes in enumerate(print_image_bytes.values(), start=1):
                storage.put(
                    get_student_image_key(
                        project_id,
                        student_id,
                        "print",
                        page_number,
                    ),
                    image_bytes,
                )
            for page_number, image_bytes in enumerate(screen_image_bytes.values(), start=1):
                storage.put(
                    get_student_image_key(
                        project_id,
                        student_id,
                        "screen",
                        page_number,
                    ),
                    image_bytes,
                )
            storage.put(render_hash_key, render_hash.encode("utf-8"))

            current_student.output_filename = print_key
            db.commit()
            try:
                _clear_legacy_student_render_outputs(
                    storage,
                    previous_output_filename,
                    protected_output_filenames,
                )
            except Exception:
                logger.exception(
                    "舊版學生輸出清理失敗 project_id=%s student_id=%s",
                    project_id,
                    student_id,
                )

        return {"pdf": print_key, "pages": len(rendered_print_images)}
