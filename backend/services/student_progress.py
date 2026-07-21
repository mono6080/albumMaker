"""單一學生照片與可填文字進度的唯一計算來源。

老師進度報表與「標記單生完成」的前置檢查共用此計算,規則必須一致:
合併全班文字、排除跳頁與固定/不可填文字。
"""

from services.label_texts import (
    get_label_entry_text,
    merge_project_label_texts_into_pages,
)
from services.layout_group_traversal import iter_layout_render_elements


def text_label_is_fillable(label: dict) -> bool:
    """與前端 textLabelRoles.js 相同:固定文字不列入老師填寫進度。"""
    role = label.get("text_role", label.get("textRole"))
    return role != "static" and label.get("editable") is not False


def summarize_student_progress(
    pages_data: list,
    page_layouts: list[dict],
    project_label_texts: dict,
) -> tuple[int, int, int, int]:
    """回傳單一學生的照片與老師可填文字之已填/總格數。"""
    merged_pages = merge_project_label_texts_into_pages(
        pages_data,
        project_label_texts,
        page_layouts,
    )
    merged_by_index = {
        page_data.get("page_index"): page_data
        for page_data in merged_pages
        if isinstance(page_data, dict)
    }

    photo_filled_count = 0
    photo_total_count = 0
    text_filled_count = 0
    text_total_count = 0
    for page_index, layout in enumerate(page_layouts):
        page_data = merged_by_index.get(page_index, {})
        if page_data.get("skip"):
            continue
        page_photos = page_data.get("photos") or {}
        merged_label_texts = page_data.get("label_texts") or {}
        for element_type, element, _ in iter_layout_render_elements(layout):
            if element_type == "photo":
                photo_total_count += 1
                if page_photos.get(str(element.get("id"))):
                    photo_filled_count += 1
                continue
            if element_type != "text" or not text_label_is_fillable(element):
                continue
            text_total_count += 1
            label_id = str(element.get("id"))
            effective_text = get_label_entry_text(merged_label_texts.get(label_id))
            if str(effective_text or "").strip():
                text_filled_count += 1
    return (
        photo_filled_count,
        photo_total_count,
        text_filled_count,
        text_total_count,
    )
