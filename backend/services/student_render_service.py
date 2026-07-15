import hashlib
import json
import threading
from contextlib import contextmanager
from pathlib import Path

from database import Project, Student
from services.label_texts import merge_project_label_texts_into_pages
from services.layout_groups import layout_for_render_fingerprint
from services.output_keys import build_combined_stem, get_project_output_prefix
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


def get_template_page_layouts(project: Project) -> list[dict]:
    """讀取模板頁面 layout，並注入渲染所需背景 key。"""
    page_layouts = []
    for template_page in project.template.pages:
        layout = json.loads(template_page.layout_json)
        layout["background_filename"] = template_page.background_filename
        page_layouts.append(layout)
    return page_layouts


_SERVICES_DIR = Path(__file__).resolve().parent
_RENDER_PIPELINE_FILES = (
    _SERVICES_DIR / "render_service.py",
    _SERVICES_DIR / "student_render_service.py",
    _SERVICES_DIR / "label_texts.py",
    _SERVICES_DIR / "layout_groups.py",
    _SERVICES_DIR / "element_renderers.py",
    _SERVICES_DIR / "draw_helpers.py",
    _SERVICES_DIR / "photo_frame_geometry.py",
    _SERVICES_DIR / "design_tokens.json",
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


def _clear_student_render_outputs(storage, output_prefix: str, combined_stem: str) -> None:
    """只清除指定學生的兩份 PDF 與專屬頁面圖／render state。"""
    storage.delete(f"{output_prefix}/{combined_stem}.pdf")
    storage.delete(f"{output_prefix}/{combined_stem}_screen.pdf")
    storage.delete_prefix(f"{output_prefix}/{combined_stem}")


def clear_student_render_outputs(
    storage,
    project_id: int,
    project_name: str,
    student_name: str,
    output_filename: str | None,
) -> None:
    """依既有 DB key 與姓名清除單一學生的 canonical render outputs。"""
    output_targets = {
        (
            get_project_output_prefix(project_id),
            build_combined_stem(project_name, student_name),
        )
    }
    if output_filename:
        from pathlib import PurePosixPath

        output_path = PurePosixPath(output_filename)
        output_targets.add((str(output_path.parent), output_path.stem))
    for output_prefix, combined_stem in output_targets:
        _clear_student_render_outputs(storage, output_prefix, combined_stem)


def _album_render_hash(
    page_layouts: list[dict],
    student_name: str,
    student_pages_data: list,
) -> str:
    """渲染輸入的內容指紋。"""
    payload = json.dumps(
        {
            "pipeline": _RENDER_PIPELINE_VERSION,
            "layouts": [layout_for_render_fingerprint(layout) for layout in page_layouts],
            "name": student_name,
            "pages": student_pages_data,
        },
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _capture_student_render_input(project_id: int, student_id: int, db) -> dict:
    """在短鎖內取得同一版本的模板、專案文字與學生資料，慢渲染不持鎖。"""
    with lock_project_content_writes([project_id]), lock_student_page_writes([student_id]):
        db.rollback()
        db.expire_all()
        current_project = db.get(Project, project_id)
        current_student = db.get(Student, student_id)
        if current_project is None or current_student is None or current_student.project_id != project_id:
            from fastapi import HTTPException

            raise HTTPException(
                status_code=409,
                detail={
                    "code": "render_input_changed",
                    "message": "相本內容已變更，請重新產生。",
                },
            )

        page_layouts = get_template_page_layouts(current_project)
        if not page_layouts:
            from fastapi import HTTPException

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
        render_input = {
            "project_name": current_project.name,
            "student_name": current_student.name,
            "page_layouts": page_layouts,
            "student_pages_data": student_pages_data,
            "template_revision": template_revision,
            "state_token": (
                current_project.template_id,
                template_revision,
                int(current_project.template.revision or 1),
                current_project.created_at,
                current_student.created_at,
                current_project.name,
                project_label_texts_raw,
                current_student.name,
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
    return (
        current_project.template_id,
        int(current_project.template_revision or 1),
        int(current_project.template.revision or 1),
        current_project.created_at,
        current_student.created_at,
        current_project.name,
        current_project.label_texts_json or "{}",
        current_student.name,
        current_student.pages_data_json,
    )


def _raise_render_input_changed(captured_revision: int, current_token: tuple | None) -> None:
    from fastapi import HTTPException

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
) -> dict:
    """捕捉、渲染並以內容 CAS 發布單一學生相冊。"""
    del project
    student_id = student.id
    with _lock_student_render(student_id):
        render_input = _capture_student_render_input(project_id, student_id, db)
        page_layouts = render_input["page_layouts"]
        student_name = render_input["student_name"]
        student_pages_data = render_input["student_pages_data"]
        combined_stem = build_combined_stem(render_input["project_name"], student_name)
        output_prefix = get_project_output_prefix(project_id)
        print_key = f"{output_prefix}/{combined_stem}.pdf"
        screen_key = f"{output_prefix}/{combined_stem}_screen.pdf"
        render_hash_key = f"{output_prefix}/{combined_stem}/.render_state"

        storage = get_storage()
        render_hash = _album_render_hash(page_layouts, student_name, student_pages_data)
        data_map = {page.get("page_index"): page for page in student_pages_data}
        page_count = sum(1 for page_index in range(len(page_layouts)) if not data_map.get(page_index, {}).get("skip"))

        try:
            previous_hash = storage.get_bytes(render_hash_key).decode("utf-8").strip()
        except FileNotFoundError:
            previous_hash = None
        if previous_hash == render_hash and storage.exists(print_key):
            with lock_project_content_writes([project_id]), lock_student_page_writes([student_id]):
                current_token = _current_student_render_token(project_id, student_id, db)
                if current_token != render_input["state_token"]:
                    _raise_render_input_changed(render_input["template_revision"], current_token)
                current_student = db.get(Student, student_id)
                if current_student.output_filename != print_key:
                    current_student.output_filename = print_key
                    db.commit()
                else:
                    db.rollback()
            return {"pdf": print_key, "pages": page_count, "skipped": True}

        rendered_print_images = render_album(
            page_layouts,
            student_name,
            student_pages_data,
            output_size=PRINT_OUTPUT_SIZE,
        )
        rendered_screen_images = derive_screen_images(rendered_print_images)
        print_pdf_bytes = save_album_pdf(rendered_print_images, mode="print")
        screen_pdf_bytes = save_album_pdf(rendered_screen_images, mode="screen")
        print_image_bytes = save_album_images(rendered_print_images, combined_stem, mode="print")
        screen_image_bytes = save_album_images(rendered_screen_images, combined_stem, mode="screen")

        with lock_project_content_writes([project_id]), lock_student_page_writes([student_id]):
            current_token = _current_student_render_token(project_id, student_id, db)
            if current_token != render_input["state_token"]:
                _raise_render_input_changed(render_input["template_revision"], current_token)

            _clear_student_render_outputs(storage, output_prefix, combined_stem)
            storage.put(print_key, print_pdf_bytes)
            storage.put(screen_key, screen_pdf_bytes)
            for filename, image_bytes in print_image_bytes.items():
                storage.put(
                    f"{output_prefix}/{combined_stem}/images/print/{filename}",
                    image_bytes,
                )
            for filename, image_bytes in screen_image_bytes.items():
                storage.put(
                    f"{output_prefix}/{combined_stem}/images/screen/{filename}",
                    image_bytes,
                )
            storage.put(render_hash_key, render_hash.encode("utf-8"))

            current_student = db.get(Student, student_id)
            current_student.output_filename = print_key
            db.commit()

        return {"pdf": print_key, "pages": len(rendered_print_images)}
