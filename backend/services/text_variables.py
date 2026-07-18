"""相本文字變數的統一解析規則。"""

from services.label_texts import MAX_LABEL_TEXT_LENGTH


ALBUM_NAME_VARIABLE = "{name}"
FULL_NAME_VARIABLE = "{full_name}"
ALBUM_NAME_PREVIEW_PLACEHOLDER = "（相本稱呼）"
FULL_NAME_PREVIEW_PLACEHOLDER = "（完整姓名）"


def get_effective_album_name(full_name: str, album_name: str | None = None) -> str:
    """取得版面使用的相本稱呼；舊資料未設定時沿用完整姓名。"""
    safe_full_name = full_name if isinstance(full_name, str) else ""
    if album_name is None:
        return safe_full_name
    return album_name if isinstance(album_name, str) else ""


def resolve_student_text_variables(
    raw_text: str,
    full_name: str,
    album_name: str | None = None,
) -> str:
    """解析姓名變數，並維持既有文字欄位的長度上限。"""
    if not isinstance(raw_text, str):
        return ""
    safe_full_name = full_name if isinstance(full_name, str) else ""
    safe_full_name = safe_full_name[:MAX_LABEL_TEXT_LENGTH]
    safe_album_name = get_effective_album_name(full_name, album_name)
    safe_album_name = safe_album_name[:MAX_LABEL_TEXT_LENGTH]
    return (
        raw_text[:MAX_LABEL_TEXT_LENGTH]
        .replace(ALBUM_NAME_VARIABLE, safe_album_name)
        .replace(FULL_NAME_VARIABLE, safe_full_name)
    )[:MAX_LABEL_TEXT_LENGTH]
