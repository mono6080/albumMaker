import io
import re
import zipfile
from collections import Counter
from pathlib import PurePosixPath

from fastapi import HTTPException

from database import Project, ProjectStudent
from services.output_keys import (
    build_combined_stem,
    make_safe_filename,
    student_output_prefix_from_pdf_key,
    student_pdf_key_for_mode,
)
from services.storage_factory import get_storage
from services.student_pages import parse_pages_data, photo_record_key
from services.zip_stream import open_zip_stream


def get_student_pdf_download(
    project: Project,
    student: ProjectStudent,
    output_mode: str,
) -> tuple[bytes, str]:
    """讀取學生 PDF 並回傳 bytes 與下載檔名。"""
    if not student.output_filename:
        raise HTTPException(status_code=404, detail="尚未產生 PDF，請先渲染")
    pdf_key = student_pdf_key_for_mode(student.output_filename, output_mode)
    storage = get_storage()
    if not storage.exists(pdf_key):
        raise HTTPException(status_code=404, detail="PDF file missing — please render first")
    combined_stem = build_combined_stem(project.name, student.name)
    screen_suffix = "_screen" if output_mode == "screen" else ""
    return storage.get_bytes(pdf_key), f"{combined_stem}{screen_suffix}.pdf"


def _student_pdf_zip_entry(
    project: Project,
    student: ProjectStudent,
    output_mode: str,
    download_stem: str | None = None,
) -> tuple[str, str] | None:
    if not student.output_filename:
        return None
    pdf_key = student_pdf_key_for_mode(student.output_filename, output_mode)
    combined_stem = download_stem or build_combined_stem(project.name, student.name)
    suffix = "_screen" if output_mode == "screen" else ""
    return (f"{combined_stem}{suffix}.pdf", pdf_key)


def _plan_student_image_keys(
    project: Project,
    student: ProjectStudent,
    output_mode: str,
    download_stem: str | None = None,
) -> list[tuple[str, list[str]]]:
    if not student.output_filename:
        return []

    canonical_prefix = student_output_prefix_from_pdf_key(student.output_filename)
    legacy_rendered_prefix = str(PurePosixPath(student.output_filename).with_suffix(""))
    legacy_rendered_stem = legacy_rendered_prefix.rsplit("/", 1)[-1]
    archive_stem = download_stem or build_combined_stem(project.name, student.name)
    mode_suffix = "_screen" if output_mode == "screen" else ""

    planned = []
    for page_number in range(1, len(project.template.pages) + 1):
        if canonical_prefix is not None:
            candidate_keys = [
                f"{canonical_prefix}/images/{output_mode}/page{page_number}.jpg",
            ]
        else:
            candidate_keys = [
                (
                    f"{legacy_rendered_prefix}/images/{output_mode}/"
                    f"{legacy_rendered_stem}{mode_suffix}_page{page_number}.jpg"
                ),
                (
                    f"{legacy_rendered_prefix}/"
                    f"{legacy_rendered_stem}_page{page_number}.jpg"
                ),
            ]
        planned.append((f"{archive_stem}{mode_suffix}_page{page_number}.jpg", candidate_keys))
    return planned


def _unique_student_download_stems(project: Project) -> dict[int, str]:
    """同名或安全化後同名時才附 student ID，避免全班 ZIP 內路徑互覆。"""
    stems = {
        student.id: build_combined_stem(project.name, student.name)
        for student in project.students
    }
    stem_counts = Counter(stems.values())
    unique_stems: dict[int, str] = {}
    used_stems: set[str] = set()
    for student_id, stem in stems.items():
        candidate = stem if stem_counts[stem] == 1 else f"{stem}-student{student_id}"
        if candidate in used_stems:
            candidate = f"{stem}-student{student_id}"
        sequence = 2
        while candidate in used_stems:
            candidate = f"{stem}-student{student_id}-{sequence}"
            sequence += 1
        unique_stems[student_id] = candidate
        used_stems.add(candidate)
    return unique_stems


def _read_first_existing(storage, candidate_keys: list[str]) -> bytes | None:
    for key in candidate_keys:
        try:
            return storage.get_bytes(key)
        except FileNotFoundError:
            continue
    return None


def get_student_image_entry(
    project: Project,
    student: ProjectStudent,
    output_mode: str,
    page_number: int,
) -> tuple[str, bytes] | None:
    """讀取第 page_number 張既存單頁圖(1-based),只抓目標頁的 bytes。

    以 exists 走訪計數既存頁(缺頁跳過,與 get_student_image_entries 同序),
    不像整批版把所有頁的 bytes 都讀出來。找不到回 None。
    """
    storage = get_storage()
    existing_count = 0
    for archive_name, candidate_keys in _plan_student_image_keys(
        project,
        student,
        output_mode,
    ):
        existing_key = next(
            (key for key in candidate_keys if storage.exists(key)),
            None,
        )
        if existing_key is None:
            continue
        existing_count += 1
        if existing_count == page_number:
            try:
                return archive_name, storage.get_bytes(existing_key)
            except FileNotFoundError:
                return None
    return None


def get_student_image_entries(
    project: Project,
    student: ProjectStudent,
    output_mode: str,
) -> list[tuple[str, bytes]]:
    storage = get_storage()
    entries = []
    for archive_name, candidate_keys in _plan_student_image_keys(
        project,
        student,
        output_mode,
    ):
        image_bytes = _read_first_existing(storage, candidate_keys)
        if image_bytes is not None:
            entries.append((archive_name, image_bytes))
    return entries


def build_zip_of_student_images(
    project: Project,
    student: ProjectStudent,
    output_mode: str,
    image_entries: list[tuple[str, bytes]] | None = None,
) -> bytes:
    if image_entries is None:
        image_entries = get_student_image_entries(project, student, output_mode)

    output_buffer = io.BytesIO()
    with zipfile.ZipFile(output_buffer, "w", zipfile.ZIP_STORED) as zip_archive:
        for filename, image_bytes in image_entries:
            zip_archive.writestr(filename, image_bytes)
    output_buffer.seek(0)
    return output_buffer.read()


def open_all_student_pdfs_zip_stream(project: Project, output_mode: str):
    storage = get_storage()
    download_stems = _unique_student_download_stems(project)
    pdf_entries = [
        entry
        for student in project.students
        if (
            entry := _student_pdf_zip_entry(
                project,
                student,
                output_mode,
                download_stems[student.id],
            )
        )
    ]

    def write_entries(zip_archive):
        for archive_name, pdf_key in pdf_entries:
            try:
                pdf_bytes = storage.get_bytes(pdf_key)
            except FileNotFoundError:
                continue
            zip_archive.writestr(archive_name, pdf_bytes)
            yield

    return open_zip_stream(write_entries, "ZIP 正在產生中，請稍後再試")


def open_all_student_images_zip_stream(project: Project, output_mode: str):
    storage = get_storage()
    download_stems = _unique_student_download_stems(project)
    planned_entries = [
        (f"{download_stems[student.id]}/{archive_name}", candidate_keys)
        for student in project.students
        for archive_name, candidate_keys in _plan_student_image_keys(
            project,
            student,
            output_mode,
            download_stems[student.id],
        )
    ]

    def write_entries(zip_archive):
        for archive_path, candidate_keys in planned_entries:
            image_bytes = _read_first_existing(storage, candidate_keys)
            if image_bytes is None:
                continue
            zip_archive.writestr(archive_path, image_bytes)
            yield

    return open_zip_stream(write_entries, "ZIP 正在產生中，請稍後再試")


# ── 上傳照片 ZIP（原始素材，不套完成閘門）─────────────────────────────────────

# photo key 尾段格式：p{page_index}_slot{slot_id}_{stem}_{content-hash16}{ext}
_UPLOADED_PHOTO_KEY_PREFIX_PATTERN = re.compile(r"^p\d+_slot\d+_")
_UPLOADED_PHOTO_CONTENT_HASH_PATTERN = re.compile(r"_[0-9a-f]{16}(?=\.[^.]*$)")


def iter_student_uploaded_photo_entries(student: ProjectStudent) -> list[tuple[int, int, str]]:
    """列舉學生所有已放照片的 (page_index, slot_id, photo_key)。"""
    entries: list[tuple[int, int, str]] = []
    for page_index, page in enumerate(parse_pages_data(student.pages_data_json)):
        for slot_id, record in (page.get("photos") or {}).items():
            photo_key = photo_record_key(record)
            if photo_key:
                entries.append((page_index, int(slot_id), photo_key))
    return entries


def _approximate_original_photo_filename(photo_key: str) -> str:
    """從 photo key 尾段剝除頁格前綴與 content-hash，還原近似原檔名。"""
    basename = PurePosixPath(photo_key).name
    basename = _UPLOADED_PHOTO_KEY_PREFIX_PATTERN.sub("", basename)
    return _UPLOADED_PHOTO_CONTENT_HASH_PATTERN.sub("", basename)


def _plan_student_uploaded_photo_entries(student: ProjectStudent) -> list[tuple[str, str]]:
    """組出單生上傳照片的 (ZIP 內檔名, photo_key)；同生撞名附 -2/-3 序號。"""
    planned: list[tuple[str, str]] = []
    used_names: set[str] = set()
    for page_index, slot_id, photo_key in iter_student_uploaded_photo_entries(student):
        original_name = _approximate_original_photo_filename(photo_key)
        archive_name = make_safe_filename(f"p{page_index + 1}_格{slot_id}_{original_name}")
        candidate = archive_name
        sequence = 2
        while candidate in used_names:
            name_path = PurePosixPath(archive_name)
            candidate = f"{name_path.stem}-{sequence}{name_path.suffix}"
            sequence += 1
        used_names.add(candidate)
        planned.append((candidate, photo_key))
    return planned


def _open_planned_photos_zip_stream(planned_entries: list[tuple[str, str]]):
    storage = get_storage()

    def write_entries(zip_archive):
        for archive_path, photo_key in planned_entries:
            try:
                photo_bytes = storage.get_bytes(photo_key)
            except FileNotFoundError:
                continue
            zip_archive.writestr(archive_path, photo_bytes)
            yield

    return open_zip_stream(write_entries, "ZIP 正在產生中，請稍後再試")


def open_student_uploaded_photos_zip_stream(student: ProjectStudent):
    """單生上傳照片 ZIP 串流；尚無照片時回 404（在串流開始前判斷）。"""
    planned_entries = _plan_student_uploaded_photo_entries(student)
    if not planned_entries:
        raise HTTPException(status_code=404, detail="此學生尚無上傳照片")
    return _open_planned_photos_zip_stream(planned_entries)


def open_all_student_uploaded_photos_zip_stream(project: Project):
    """全班上傳照片 ZIP 串流，每生一個資料夾；尚無照片時回 404。"""
    download_stems = _unique_student_download_stems(project)
    planned_entries = [
        (f"{download_stems[student.id]}/{archive_name}", photo_key)
        for student in project.students
        for archive_name, photo_key in _plan_student_uploaded_photo_entries(student)
    ]
    if not planned_entries:
        raise HTTPException(status_code=404, detail="此專案尚無上傳照片")
    return _open_planned_photos_zip_stream(planned_entries)
