# 專案業務邏輯服務模組
# 集中管理與「渲染學生相冊」、「合併對應文字」、「檔名處理」、
# 「HTTP 下載標頭」相關的業務邏輯，使路由層保持薄且清晰

import hashlib
import io
import json
import logging
import re
import threading
import zipfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from database import Project, Student, utc_now
from services.label_texts import (
    get_label_entry_text,
    label_entry_has_style_override,
    merge_label_entries,
    normalize_label_entry,
)
from services.layout_groups import layout_for_render_fingerprint
from services.render_service import (
    PRINT_OUTPUT_SIZE,
    derive_screen_images,
    render_album,
    save_album_pdf,
    save_album_images,
)
from services.storage import get_storage
from services.student_pages import lock_student_page_writes
from services.template_sync_locks import lock_project_content_writes
from services.zip_stream import open_zip_stream

logger = logging.getLogger(__name__)


def purge_expired_archived_projects(db, now: datetime | None = None) -> list[int]:
    """刪除超過復原期限的專案與整個 storage namespace。"""
    cutoff = now or utc_now()
    expired_project_ids = [
        project_id
        for project_id, in (
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
        # 初查與拿到鎖之間可能剛被復原；鎖內重新查詢才是刪除依據。
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
                logger.error("過期專案 storage 清理失敗 project_id=%s: %s", project.id, storage_error)
                continue
            purged_project_ids.append(project.id)
            db.delete(project)
        if purged_project_ids:
            db.commit()
            logger.info("已清理過期封存專案 project_ids=%s", purged_project_ids)
    return purged_project_ids


# ── 檔名與目錄工具 ─────────────────────────────────────────────────────────────

def make_safe_filename(name: str) -> str:
    """將名稱中的 Windows / Linux 非法字元替換為底線，確保可用作檔名。"""
    return re.sub(r'[\\/:*?"<>|]', '_', name).strip() or "unnamed"


def get_project_output_prefix(project_id: int) -> str:
    """回傳專案輸出檔案的 storage key 前綴。"""
    return f"projects/proj{project_id}/output"


def build_combined_stem(project_name: str, student_name: str) -> str:
    """組合專案名稱與學生名稱為安全的檔名主體，格式為「專案名-學生名」。"""
    safe_project = make_safe_filename(project_name)
    safe_student = make_safe_filename(student_name)
    return f"{safe_project}-{safe_student}"


def student_pdf_key_for_mode(base_key: str, output_mode: str) -> str:
    """由列印版 PDF key（students.output_filename）推導指定畫質的 key。

    screen 版＝同檔名主體加 _screen 後綴，保留原副檔名。
    """
    if output_mode != "screen":
        return base_key
    path = PurePosixPath(base_key)
    return str(path.with_name(f"{path.stem}_screen{path.suffix}"))


# ── HTTP 下載標頭工具 ──────────────────────────────────────────────────────────

def build_content_disposition_header(filename: str) -> str:
    """
    建立符合 RFC 5987 的 Content-Disposition 下載標頭。
    同時提供 ASCII 備用檔名（非 ASCII 字元替換為底線）與 UTF-8 百分比編碼版本，
    確保各瀏覽器均能正確顯示中文檔名。
    """
    encoded_filename = quote(filename, safe="")
    ascii_fallback = re.sub(r'[^\x00-\x7F]', '_', filename)
    return f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded_filename}'


# ── 對應文字合併 ───────────────────────────────────────────────────────────────

def _inherited_label_texts(label_texts: dict) -> dict:
    """保留文字覆寫設定；空字串代表刻意輸出空白。"""
    inherited = {}
    for label_id, text in (label_texts or {}).items():
        normalized = normalize_label_entry(text)
        if normalized is not None:
            inherited[str(label_id)] = normalized
    return inherited


def _template_label_texts_for_page(page_layouts: list[dict] | None, page_index_key: str) -> dict:
    if page_layouts is None:
        return {}
    try:
        page_layout = page_layouts[int(page_index_key)]
    except (IndexError, TypeError, ValueError):
        return {}
    return {
        str(label.get("id")): label.get("text", "")
        for label in page_layout.get("text_labels", [])
        if label.get("id") is not None
    }


def _drop_legacy_template_default_overrides(
    student_label_texts: dict,
    project_label_texts: dict,
    template_label_texts: dict,
) -> dict:
    """舊版前端可能把模板預設文字存成學生覆寫；有專案覆寫時讓它回到繼承。"""
    if not project_label_texts or not template_label_texts:
        return student_label_texts
    return {
        label_id: text
        for label_id, text in student_label_texts.items()
        if not (
            label_id in project_label_texts
            and label_id in template_label_texts
            and get_label_entry_text(text) == template_label_texts[label_id]
            and not label_entry_has_style_override(text)
        )
    }


def _merge_page_label_texts(project_page_label_texts: dict, student_page_label_texts: dict) -> dict:
    merged = {}
    for label_id in set(project_page_label_texts) | set(student_page_label_texts):
        merged_entry = merge_label_entries(
            project_page_label_texts.get(label_id),
            student_page_label_texts.get(label_id),
        )
        if merged_entry is not None:
            merged[label_id] = merged_entry
    return merged


def merge_project_label_texts_into_pages(
    student_pages_data: list,
    project_label_texts: dict,
    page_layouts: list[dict] | None = None,
) -> list:
    """
    將專案層級對應文字合併入學生頁面資料，作為學生未自訂時的預設值。

    優先順序（高到低）：
      學生個人對應文字 > 專案層級對應文字 > 模板預設文字（由 render_page 處理）

    回傳新的 pages_data 列表，不修改原始物件。
    若學生尚無頁面資料（如剛建立的新學生），仍會補入專案層級文字，
    確保渲染時能正確顯示全班預設文字。
    """
    # 用 student_pages_data 建立以 page_index 為鍵的查找表
    student_page_indices = {str(page_data.get("page_index", 0)) for page_data in student_pages_data}

    merged_pages = []
    for page_data in student_pages_data:
        page_index_key = str(page_data.get("page_index", 0))
        project_page_label_texts = _inherited_label_texts(project_label_texts.get(page_index_key, {}))
        student_page_label_texts = _inherited_label_texts(page_data.get("label_texts", {}))
        student_page_label_texts = _drop_legacy_template_default_overrides(
            student_page_label_texts,
            project_page_label_texts,
            _template_label_texts_for_page(page_layouts, page_index_key),
        )
        if project_page_label_texts or student_page_label_texts:
            # 學生的設定優先；專案設定補足尚未覆寫的對應文字
            merged_label_texts = _merge_page_label_texts(project_page_label_texts, student_page_label_texts)
            page_data = {**page_data, "label_texts": merged_label_texts}
        merged_pages.append(page_data)

    # 補充：project_label_texts 中有但學生尚無頁面資料的頁面（如剛建立的學生）
    for page_index_key, page_label_texts in project_label_texts.items():
        inherited_page_label_texts = _inherited_label_texts(page_label_texts)
        if page_index_key not in student_page_indices and inherited_page_label_texts:
            merged_pages.append({
                "page_index": int(page_index_key),
                "photos": {},
                "label_texts": inherited_page_label_texts,
            })

    return merged_pages


# ── 模板頁面佈局讀取 ───────────────────────────────────────────────────────────

def get_template_page_layouts(project: Project) -> list[dict]:
    """
    從關聯的模板頁面中讀取所有佈局設定，
    並將背景圖檔名注入佈局 dict（渲染時需要）。
    """
    page_layouts = []
    for template_page in project.template.pages:
        layout = json.loads(template_page.layout_json)
        layout["background_filename"] = template_page.background_filename
        page_layouts.append(layout)
    return page_layouts


# ── 渲染與儲存 ─────────────────────────────────────────────────────────────────

_SERVICES_DIR = Path(__file__).resolve().parent
_RENDER_PIPELINE_FILES = (
    _SERVICES_DIR / "render_service.py",
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
        output_path = PurePosixPath(output_filename)
        output_targets.add((str(output_path.parent), output_path.stem))
    for output_prefix, combined_stem in output_targets:
        _clear_student_render_outputs(storage, output_prefix, combined_stem)


def _album_render_hash(page_layouts: list[dict], student_name: str, student_pages_data: list) -> str:
    """渲染輸入的內容指紋：版面＋合併後頁面資料＋姓名相同 ⇒ 輸出必相同。

    照片內容變更由 pages_data 內的照片 key 與版本欄位（v）反映；
    背景圖同檔名重傳由 layout 的 background_version 反映。
    """
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
        # 路由通常已讀過 ORM 物件；先結束舊 read transaction，才能看見剛完成的模板同步。
        db.rollback()
        db.expire_all()
        current_project = db.get(Project, project_id)
        current_student = db.get(Student, student_id)
        if current_project is None or current_student is None or current_student.project_id != project_id:
            from fastapi import HTTPException
            raise HTTPException(status_code=409, detail={
                "code": "render_input_changed",
                "message": "相本內容已變更，請重新產生。",
            })

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
        # 不讓 read transaction 橫跨 PIL 渲染；模板儲存可在此期間立即完成。
        db.rollback()
        return render_input


def _current_student_render_token(project_id: int, student_id: int, db) -> tuple | None:
    """publish 前重新讀取 CAS token；None 表示專案／學生已不存在或換綁。"""
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
    raise HTTPException(status_code=409, detail={
        "code": "render_input_changed",
        "message": "模板或相本內容已在產生期間更新，請重新產生。",
        "captured_revision": captured_revision,
        "current_revision": current_revision,
    })


def render_and_save_student_album(
    project: Project,
    student: Student,
    project_id: int,
    db,
) -> dict:
    """
    渲染單一學生的相冊頁面並儲存為 PDF 與頁面圖片。

    流程：
      1. 在短鎖內捕捉模板 revision、佈局與學生內容
      2. 將專案對應文字合併入學生頁面資料
      3. 內容指紋與上次相同且輸出還在 ⇒ 直接跳過（全班重渲只重做有改過的學生）
      4. 呼叫渲染引擎產生列印圖，螢幕圖由列印圖降採樣
      5. publish 前以相同內容鎖重讀並比對 revision／內容 token
      6. CAS 通過後才儲存 PDF、單頁圖片、指紋並更新輸出路徑

    回傳：包含 pdf 路徑與頁數的 dict（跳過時 skipped=True）。
    """
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
        page_count = sum(
            1 for page_index in range(len(page_layouts))
            if not data_map.get(page_index, {}).get("skip")
        )

        # dirty-skip 也必須走 publish CAS；否則同步剛失效輸出時，舊工作會把路徑寫回。
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
        # 轉檔同樣在鎖外完成；publish 區段只做 storage 寫入與 DB CAS。
        rendered_screen_images = derive_screen_images(rendered_print_images)
        print_pdf_bytes = save_album_pdf(rendered_print_images, mode="print")
        screen_pdf_bytes = save_album_pdf(rendered_screen_images, mode="screen")
        print_image_bytes = save_album_images(rendered_print_images, combined_stem, mode="print")
        screen_image_bytes = save_album_images(rendered_screen_images, combined_stem, mode="screen")

        with lock_project_content_writes([project_id]), lock_student_page_writes([student_id]):
            current_token = _current_student_render_token(project_id, student_id, db)
            if current_token != render_input["state_token"]:
                _raise_render_input_changed(render_input["template_revision"], current_token)

            # CAS 通過前完全不碰 canonical keys；舊 render 晚到時因此不會覆寫 PDF/JPG/hash。
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
            # 指紋最後寫，存在即代表此 revision 的整組輸出已 publish 完整。
            storage.put(render_hash_key, render_hash.encode("utf-8"))

            current_student = db.get(Student, student_id)
            current_student.output_filename = print_key
            db.commit()

        return {"pdf": print_key, "pages": len(rendered_print_images)}


# ── ZIP 封裝 ───────────────────────────────────────────────────────────────────
# PDF 與 JPG 內容已是壓縮格式，ZIP 用 STORED（再 DEFLATE 只耗 CPU 幾乎不減量）


def _student_pdf_zip_entry(project: Project, student: Student, output_mode: str) -> tuple[str, str] | None:
    """單一學生 PDF 的（ZIP 內檔名, storage key）；未渲染回 None。"""
    if not student.output_filename:
        return None
    pdf_key = student_pdf_key_for_mode(student.output_filename, output_mode)
    combined_stem = build_combined_stem(project.name, student.name)
    suffix = "_screen" if output_mode == "screen" else ""
    return (f"{combined_stem}{suffix}.pdf", pdf_key)


def _plan_student_image_keys(project: Project, student: Student, output_mode: str) -> list[tuple[str, list[str]]]:
    """規劃單頁 JPG 的（ZIP 內檔名, 候選 storage keys）；只組字串、不做 storage I/O。"""
    if not student.output_filename:
        return []

    rendered_prefix = student.output_filename[:-4]
    rendered_stem = rendered_prefix.rsplit("/", 1)[-1]
    download_stem = build_combined_stem(project.name, student.name)
    mode_suffix = "_screen" if output_mode == "screen" else ""

    planned = []
    for page_number in range(1, len(project.template.pages) + 1):
        candidate_keys = [
            f"{rendered_prefix}/images/{output_mode}/{rendered_stem}{mode_suffix}_page{page_number}.jpg",
            # 舊版渲染只存一套 JPG 在 output/{stem}/{stem}_pageN.jpg。
            f"{rendered_prefix}/{rendered_stem}_page{page_number}.jpg",
        ]
        planned.append((f"{download_stem}{mode_suffix}_page{page_number}.jpg", candidate_keys))
    return planned


def _read_first_existing(storage, candidate_keys: list[str]) -> bytes | None:
    """依序 try-get 候選 key（省掉 R2 的逐檔 HEAD），全部不存在回 None。"""
    for key in candidate_keys:
        try:
            return storage.get_bytes(key)
        except FileNotFoundError:
            continue
    return None


def get_student_image_entries(project: Project, student: Student, output_mode: str) -> list[tuple[str, bytes]]:
    """讀取已渲染的學生單頁 JPG，回傳 ZIP 內檔名與 bytes。"""
    storage = get_storage()
    entries = []
    for arcname, candidate_keys in _plan_student_image_keys(project, student, output_mode):
        image_bytes = _read_first_existing(storage, candidate_keys)
        if image_bytes is not None:
            entries.append((arcname, image_bytes))
    return entries


def build_zip_of_student_images(
    project: Project,
    student: Student,
    output_mode: str,
    image_entries: list[tuple[str, bytes]] | None = None,
) -> bytes:
    """將單一學生已渲染的頁面 JPG 打包成 ZIP。"""
    if image_entries is None:
        image_entries = get_student_image_entries(project, student, output_mode)

    output_buffer = io.BytesIO()
    with zipfile.ZipFile(output_buffer, "w", zipfile.ZIP_STORED) as zip_archive:
        for filename, image_bytes in image_entries:
            zip_archive.writestr(filename, image_bytes)
    output_buffer.seek(0)
    return output_buffer.read()


def open_all_student_pdfs_zip_stream(project: Project, output_mode: str):
    """所有已渲染學生 PDF 的串流 ZIP 產生器。"""
    storage = get_storage()
    pdf_entries = [
        entry
        for student in project.students
        if (entry := _student_pdf_zip_entry(project, student, output_mode))
    ]

    def write_entries(zip_archive):
        for arcname, pdf_key in pdf_entries:
            try:
                pdf_bytes = storage.get_bytes(pdf_key)
            except FileNotFoundError:
                continue
            zip_archive.writestr(arcname, pdf_bytes)
            yield

    return open_zip_stream(write_entries, "ZIP 正在產生中，請稍後再試")


def open_all_student_images_zip_stream(project: Project, output_mode: str):
    """所有已渲染學生單頁 JPG 的串流 ZIP 產生器（每位學生一個資料夾）。

    key 規劃全部前置，串流階段只逐檔讀 bytes——避免 StreamingResponse
    送出期間相依的 DB session 已被回收。
    """
    storage = get_storage()
    planned_entries = [
        (f"{build_combined_stem(project.name, student.name)}/{arcname}", candidate_keys)
        for student in project.students
        for arcname, candidate_keys in _plan_student_image_keys(project, student, output_mode)
    ]

    def write_entries(zip_archive):
        for archive_path, candidate_keys in planned_entries:
            image_bytes = _read_first_existing(storage, candidate_keys)
            if image_bytes is None:
                continue
            zip_archive.writestr(archive_path, image_bytes)
            yield

    return open_zip_stream(write_entries, "ZIP 正在產生中，請稍後再試")
