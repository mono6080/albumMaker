import re
from pathlib import PurePosixPath
from urllib.parse import quote


def make_safe_filename(name: str) -> str:
    """將名稱中的 Windows / Linux 非法字元替換為底線。"""
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip() or "unnamed"


def get_project_output_prefix(project_id: int) -> str:
    return f"projects/proj{project_id}/output"


def build_combined_stem(project_name: str, student_name: str) -> str:
    safe_project = make_safe_filename(project_name)
    safe_student = make_safe_filename(student_name)
    return f"{safe_project}-{safe_student}"


def student_pdf_key_for_mode(base_key: str, output_mode: str) -> str:
    """由列印版 PDF key 推導指定畫質的 key。"""
    if output_mode != "screen":
        return base_key
    path = PurePosixPath(base_key)
    return str(path.with_name(f"{path.stem}_screen{path.suffix}"))


def build_content_disposition_header(filename: str) -> str:
    """建立 RFC 5987 Content-Disposition 下載標頭。"""
    encoded_filename = quote(filename, safe="")
    ascii_fallback = re.sub(r"[^\x00-\x7F]", "_", filename)
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded_filename}"
