import io
import zipfile

from fastapi import HTTPException

from database import Project, Student
from services.output_keys import (
    build_combined_stem,
    student_pdf_key_for_mode,
)
from services.storage_factory import get_storage
from services.zip_stream import open_zip_stream


def get_student_pdf_download(
    project: Project,
    student: Student,
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
    student: Student,
    output_mode: str,
) -> tuple[str, str] | None:
    if not student.output_filename:
        return None
    pdf_key = student_pdf_key_for_mode(student.output_filename, output_mode)
    combined_stem = build_combined_stem(project.name, student.name)
    suffix = "_screen" if output_mode == "screen" else ""
    return (f"{combined_stem}{suffix}.pdf", pdf_key)


def _plan_student_image_keys(
    project: Project,
    student: Student,
    output_mode: str,
) -> list[tuple[str, list[str]]]:
    if not student.output_filename:
        return []

    rendered_prefix = student.output_filename[:-4]
    rendered_stem = rendered_prefix.rsplit("/", 1)[-1]
    download_stem = build_combined_stem(project.name, student.name)
    mode_suffix = "_screen" if output_mode == "screen" else ""

    planned = []
    for page_number in range(1, len(project.template.pages) + 1):
        candidate_keys = [
            (f"{rendered_prefix}/images/{output_mode}/{rendered_stem}{mode_suffix}_page{page_number}.jpg"),
            f"{rendered_prefix}/{rendered_stem}_page{page_number}.jpg",
        ]
        planned.append((f"{download_stem}{mode_suffix}_page{page_number}.jpg", candidate_keys))
    return planned


def _read_first_existing(storage, candidate_keys: list[str]) -> bytes | None:
    for key in candidate_keys:
        try:
            return storage.get_bytes(key)
        except FileNotFoundError:
            continue
    return None


def get_student_image_entries(
    project: Project,
    student: Student,
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
    student: Student,
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
    pdf_entries = [
        entry for student in project.students if (entry := _student_pdf_zip_entry(project, student, output_mode))
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
    planned_entries = [
        (f"{build_combined_stem(project.name, student.name)}/{archive_name}", candidate_keys)
        for student in project.students
        for archive_name, candidate_keys in _plan_student_image_keys(
            project,
            student,
            output_mode,
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
