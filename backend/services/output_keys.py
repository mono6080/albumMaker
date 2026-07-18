import re
from pathlib import PurePosixPath
from urllib.parse import quote


_UNSAFE_FILENAME_PATTERN = re.compile(r'[\x00-\x1f\x7f\\/:*?"<>|]')


def make_safe_filename(name: str) -> str:
    """將名稱中的 Windows / Linux 非法字元與路徑語意替換為安全檔名。"""
    safe_name = _UNSAFE_FILENAME_PATTERN.sub("_", name).strip()
    return safe_name if safe_name not in {"", ".", ".."} else "unnamed"


def build_safe_zip_entry_path(*segments: str) -> str:
    """把各段顯示名稱清洗成不含 absolute／traversal 語意的 ZIP entry 路徑。"""
    if not segments:
        raise ValueError("ZIP entry 至少需要一個路徑段")
    safe_segments = [make_safe_filename(segment) for segment in segments]
    archive_path = PurePosixPath(*safe_segments)
    if archive_path.is_absolute() or any(
        part in {"", ".", ".."} for part in archive_path.parts
    ):
        raise ValueError("ZIP entry 路徑不安全")
    return archive_path.as_posix()


def get_project_output_prefix(project_id: int) -> str:
    return f"projects/proj{project_id}/output"


def get_student_output_prefix(project_id: int, student_id: int) -> str:
    """回傳不受姓名影響的學生輸出 namespace。"""
    return f"{get_project_output_prefix(project_id)}/students/student{student_id}"


def get_student_pdf_key(project_id: int, student_id: int) -> str:
    """回傳學生 canonical 列印版 PDF key。"""
    return f"{get_student_output_prefix(project_id, student_id)}/pdf/print.pdf"


def get_student_image_key(
    project_id: int,
    student_id: int,
    output_mode: str,
    page_number: int,
) -> str:
    """回傳學生指定畫質與頁碼的 canonical JPG key。"""
    return (
        f"{get_student_output_prefix(project_id, student_id)}"
        f"/images/{output_mode}/page{page_number}.jpg"
    )


def get_student_render_state_key(project_id: int, student_id: int) -> str:
    return f"{get_student_output_prefix(project_id, student_id)}/.render_state"


def build_combined_stem(project_name: str, student_name: str) -> str:
    safe_project = make_safe_filename(project_name)
    safe_student = make_safe_filename(student_name)
    return f"{safe_project}-{safe_student}"


def student_output_prefix_from_pdf_key(base_key: str) -> str | None:
    """若為新版 canonical PDF key，回傳學生 namespace；舊 key 回 None。"""
    path = PurePosixPath(base_key)
    if (
        path.name in {"print.pdf", "screen.pdf"}
        and path.parent.name == "pdf"
        and path.parent.parent.name.startswith("student")
        and path.parent.parent.parent.name == "students"
    ):
        return str(path.parent.parent)
    return None


def student_pdf_key_for_mode(base_key: str, output_mode: str) -> str:
    """由 DB 保存的列印版 PDF key 推導指定畫質；相容舊版姓名 key。"""
    canonical_prefix = student_output_prefix_from_pdf_key(base_key)
    if canonical_prefix is not None:
        return f"{canonical_prefix}/pdf/{output_mode}.pdf"
    if output_mode != "screen":
        return base_key
    path = PurePosixPath(base_key)
    return str(path.with_name(f"{path.stem}_screen{path.suffix}"))


def build_content_disposition_header(filename: str) -> str:
    """建立 RFC 5987 Content-Disposition 下載標頭。"""
    safe_filename = make_safe_filename(filename)
    encoded_filename = quote(safe_filename, safe="")
    ascii_fallback = re.sub(r"[^\x20-\x7E]", "_", safe_filename)
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded_filename}"
