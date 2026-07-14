# 模板頁面快照服務
# 將頁面新增、刪除、排序與版面更新放在同一個資料庫 transaction 中。

import json
import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import Template, TemplatePage
from services.layout_groups import validate_layout_groups
from services.storage import get_storage


logger = logging.getLogger(__name__)


def normalize_template_page_layout(layout: dict) -> dict:
    """驗證並正規化可持久化的模板頁面版面。"""
    legacy_bubbles = layout.get("text_bubbles")
    if legacy_bubbles not in (None, []):
        raise HTTPException(
            status_code=422,
            detail={
                "code": "removed_layout_element",
                "errors": [{
                    "path": "text_bubbles",
                    "message": "text_bubbles is no longer supported",
                }],
            },
        )
    normalized_layout = dict(layout)
    normalized_layout.pop("text_bubbles", None)
    group_errors = validate_layout_groups(normalized_layout)
    if group_errors:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_layout_group",
                "errors": group_errors,
            },
        )
    return normalized_layout


def _invalid_snapshot(message: str) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={"code": "invalid_template_page_snapshot", "message": message},
    )


def _validate_snapshot(
    template: Template,
    expected_page_ids: list[int],
    page_items: list[dict],
) -> tuple[list[TemplatePage], list[dict]]:
    current_pages = list(template.pages)
    current_page_ids = [page.id for page in current_pages]
    if len(expected_page_ids) != len(set(expected_page_ids)):
        raise _invalid_snapshot("expected_page_ids 不可重複")
    if expected_page_ids != current_page_ids:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "template_page_structure_changed",
                "expected_page_ids": expected_page_ids,
                "actual_page_ids": current_page_ids,
            },
        )

    existing_ids = [item["id"] for item in page_items if item.get("id") is not None]
    if len(existing_ids) != len(set(existing_ids)):
        raise _invalid_snapshot("pages[].id 不可重複")
    unknown_ids = [page_id for page_id in existing_ids if page_id not in current_page_ids]
    if unknown_ids:
        raise _invalid_snapshot("pages[].id 必須屬於目前模板")

    client_ids = [item["client_id"] for item in page_items if item.get("client_id") is not None]
    if len(client_ids) != len(set(client_ids)):
        raise _invalid_snapshot("pages[].client_id 不可重複")
    if any(item.get("id") is None and item.get("client_id") is None for item in page_items):
        raise _invalid_snapshot("新增頁面必須提供 client_id")

    normalized_items = [
        {**item, "layout": normalize_template_page_layout(item["layout"])}
        for item in page_items
    ]
    return current_pages, normalized_items


def _serialize_snapshot_page(page: TemplatePage, client_id: str | None) -> dict:
    return {
        "id": page.id,
        "client_id": client_id,
        "page_number": page.page_number,
        "background_filename": page.background_filename,
        "layout": json.loads(page.layout_json),
    }


def replace_template_pages_snapshot(
    template: Template,
    expected_page_ids: list[int],
    page_items: list[dict],
    db: Session,
) -> dict:
    """以完整快照原子取代模板頁面，並回傳 client_id 到資料庫 id 的對應。"""
    current_pages, normalized_items = _validate_snapshot(template, expected_page_ids, page_items)
    current_by_id = {page.id: page for page in current_pages}
    retained_ids = {
        item["id"]
        for item in normalized_items
        if item.get("id") is not None
    }
    deleted_pages = [page for page in current_pages if page.id not in retained_ids]
    deleted_backgrounds = [
        (page.id, page.background_filename)
        for page in deleted_pages
        if page.background_filename
    ]

    try:
        # 先搬到不衝突的暫存頁碼，避免重排時撞到複合 UNIQUE index。
        temporary_start = min([page.page_number for page in current_pages] + [0]) - len(current_pages) - 1
        for index, page in enumerate(current_pages):
            page.page_number = temporary_start - index
        db.flush()

        for page in deleted_pages:
            db.delete(page)

        ordered_pages: list[tuple[TemplatePage, str | None]] = []
        for page_number, item in enumerate(normalized_items):
            page_id = item.get("id")
            if page_id is None:
                page = TemplatePage(
                    template_id=template.id,
                    page_number=page_number,
                    layout_json=json.dumps(item["layout"]),
                )
                db.add(page)
            else:
                page = current_by_id[page_id]
                page.page_number = page_number
                page.layout_json = json.dumps(item["layout"])
            ordered_pages.append((page, item.get("client_id")))

        db.commit()
    except Exception:
        db.rollback()
        raise

    for deleted_page_id, background_filename in deleted_backgrounds:
        try:
            get_storage().delete(background_filename)
        except Exception as storage_error:
            logger.error(
                "模板頁面已刪除但背景清理失敗 template_id=%s page_id=%s: %s",
                template.id,
                deleted_page_id,
                storage_error,
            )

    return {
        "pages": [
            _serialize_snapshot_page(page, client_id)
            for page, client_id in ordered_pages
        ]
    }
