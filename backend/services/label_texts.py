import json
from pathlib import Path
from typing import Any

from fastapi import HTTPException


_DESIGN_TOKENS = json.loads(
    (Path(__file__).parent / "design_tokens.json").read_text(encoding="utf-8")
)
MAX_LABEL_TEXT_LENGTH = _DESIGN_TOKENS["text_content"]["max_label_text_length"]
MAX_LABEL_ENTRIES_PER_PAGE = 100
MAX_LABEL_TEXT_TOTAL_PER_PAGE = 4000
MAX_LABEL_ID_LENGTH = 128
TEXT_ALIGN_VALUES = {"left", "center", "right"}
LABEL_ENTRY_FIELDS = {"text", "text_align"}


def _invalid_label_texts(path: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={
            "code": "invalid_label_texts",
            "errors": [{"path": path, "message": message}],
        },
    )


def validate_page_label_texts(
    label_texts: Any,
    *,
    path: str = "label_texts",
) -> dict[str, Any]:
    """驗證單頁文字覆寫格式，避免任意 JSON 進入渲染器。"""
    if not isinstance(label_texts, dict):
        raise _invalid_label_texts(path, "must be an object")
    if len(label_texts) > MAX_LABEL_ENTRIES_PER_PAGE:
        raise _invalid_label_texts(
            path,
            f"must not contain more than {MAX_LABEL_ENTRIES_PER_PAGE} entries",
        )

    total_text_length = 0
    for label_id, entry in label_texts.items():
        if not isinstance(label_id, str) or not label_id:
            raise _invalid_label_texts(path, "label id must be a non-empty string")
        if len(label_id) > MAX_LABEL_ID_LENGTH:
            raise _invalid_label_texts(
                path,
                f"label id must not exceed {MAX_LABEL_ID_LENGTH} characters",
            )
        entry_path = f"{path}.{label_id}"
        if isinstance(entry, str):
            if len(entry) > MAX_LABEL_TEXT_LENGTH:
                raise _invalid_label_texts(
                    entry_path,
                    f"must not exceed {MAX_LABEL_TEXT_LENGTH} characters",
                )
            total_text_length += len(entry)
            continue
        if not isinstance(entry, dict):
            raise _invalid_label_texts(
                entry_path,
                "must be a string or an object with text/text_align",
            )
        unknown_fields = set(entry) - LABEL_ENTRY_FIELDS
        if unknown_fields:
            raise _invalid_label_texts(
                entry_path,
                f"unsupported fields: {', '.join(sorted(str(field) for field in unknown_fields))}",
            )
        if "text" in entry and entry["text"] is not None and not isinstance(entry["text"], str):
            raise _invalid_label_texts(f"{entry_path}.text", "must be a string or null")
        if isinstance(entry.get("text"), str):
            if len(entry["text"]) > MAX_LABEL_TEXT_LENGTH:
                raise _invalid_label_texts(
                    f"{entry_path}.text",
                    f"must not exceed {MAX_LABEL_TEXT_LENGTH} characters",
                )
            total_text_length += len(entry["text"])
        if "text_align" in entry and entry["text_align"] not in TEXT_ALIGN_VALUES:
            raise _invalid_label_texts(
                f"{entry_path}.text_align",
                "must be left, center, or right",
            )
    if total_text_length > MAX_LABEL_TEXT_TOTAL_PER_PAGE:
        raise _invalid_label_texts(
            path,
            (
                "total text length must not exceed "
                f"{MAX_LABEL_TEXT_TOTAL_PER_PAGE} characters"
            ),
        )
    return label_texts


def normalize_text_align(value) -> str | None:
    return value if value in TEXT_ALIGN_VALUES else None


def label_entry_to_fields(entry) -> dict:
    if entry is None:
        return {}

    if isinstance(entry, dict):
        fields = {}
        if "text" in entry and entry.get("text") is not None:
            fields["text"] = str(entry.get("text"))
        text_align = normalize_text_align(entry.get("text_align"))
        if text_align:
            fields["text_align"] = text_align
        return fields

    return {"text": str(entry)}


def fields_to_label_entry(fields: dict, prefer_object: bool = False):
    if not fields:
        return None
    if not prefer_object and set(fields) == {"text"}:
        return fields["text"]
    return dict(fields)


def normalize_label_entry(entry):
    return fields_to_label_entry(label_entry_to_fields(entry), isinstance(entry, dict))


def get_label_entry_text(entry, default=None):
    fields = label_entry_to_fields(entry)
    return fields.get("text", default)


def get_label_entry_align(entry, default: str = "center") -> str:
    fields = label_entry_to_fields(entry)
    return fields.get("text_align") or default


def label_entry_has_style_override(entry) -> bool:
    return "text_align" in label_entry_to_fields(entry)


def merge_label_entries(base_entry, override_entry):
    base_fields = label_entry_to_fields(base_entry)
    override_fields = label_entry_to_fields(override_entry)
    merged_fields = {**base_fields, **override_fields}
    prefer_object = (
        isinstance(base_entry, dict)
        or isinstance(override_entry, dict)
        or "text_align" in merged_fields
    )
    return fields_to_label_entry(merged_fields, prefer_object)


def _inherited_label_texts(label_texts: dict) -> dict:
    """保留文字覆寫設定；空字串代表刻意輸出空白。"""
    inherited = {}
    for label_id, text in (label_texts or {}).items():
        normalized = normalize_label_entry(text)
        if normalized is not None:
            inherited[str(label_id)] = normalized
    return inherited


def _template_label_texts_for_page(
    page_layouts: list[dict] | None,
    page_index_key: str,
) -> dict:
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


def _merge_page_label_texts(
    project_page_label_texts: dict,
    student_page_label_texts: dict,
) -> dict:
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
    """以學生 > 專案 > 模板的順序合併對應文字，不修改輸入物件。"""
    student_page_indices = {
        str(page_data.get("page_index", 0))
        for page_data in student_pages_data
    }

    merged_pages = []
    for page_data in student_pages_data:
        page_index_key = str(page_data.get("page_index", 0))
        project_page_label_texts = _inherited_label_texts(
            project_label_texts.get(page_index_key, {})
        )
        student_page_label_texts = _inherited_label_texts(page_data.get("label_texts", {}))
        student_page_label_texts = _drop_legacy_template_default_overrides(
            student_page_label_texts,
            project_page_label_texts,
            _template_label_texts_for_page(page_layouts, page_index_key),
        )
        if project_page_label_texts or student_page_label_texts:
            merged_label_texts = _merge_page_label_texts(
                project_page_label_texts,
                student_page_label_texts,
            )
            page_data = {**page_data, "label_texts": merged_label_texts}
        merged_pages.append(page_data)

    for page_index_key, page_label_texts in project_label_texts.items():
        inherited_page_label_texts = _inherited_label_texts(page_label_texts)
        if page_index_key not in student_page_indices and inherited_page_label_texts:
            merged_pages.append({
                "page_index": int(page_index_key),
                "photos": {},
                "label_texts": inherited_page_label_texts,
            })

    return merged_pages
