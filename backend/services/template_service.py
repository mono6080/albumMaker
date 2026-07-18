# 模板服務
# 模板複製流程：跨模板複製頁面版面，並連帶複製背景圖與貼圖素材檔案

import json
import posixpath

from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import Template, TemplatePage
from services.file_service import get_background_key, get_sticker_key
from services.layout_geometry_validation import validate_template_page_count
from services.storage import get_storage
from services.template_page_snapshot_service import normalize_template_page_layout


def _copy_storage_key(storage, source_key: str, target_key: str) -> bool:
    try:
        data = storage.get_bytes(source_key)
    except FileNotFoundError:
        return False
    storage.put(target_key, data)
    return True


def _copy_layout_sticker_assets(
    layout: dict,
    source_template_id: int,
    target_template_id: int,
    storage,
) -> dict:
    copied_layout = json.loads(json.dumps(layout))
    # key 格式一律由 file_service 推導，避免複製流程與上傳流程各自維護同一格式
    source_prefix = get_sticker_key(source_template_id, "")
    copied_paths: set[str] = set()

    for sticker in copied_layout.get("stickers") or []:
        if not isinstance(sticker, dict):
            continue
        source_path = sticker.get("path")
        if not isinstance(source_path, str) or not source_path.startswith(source_prefix):
            continue

        target_path = get_sticker_key(target_template_id, posixpath.basename(source_path))
        if target_path not in copied_paths:
            _copy_storage_key(storage, source_path, target_path)
            copied_paths.add(target_path)
        sticker["path"] = target_path

    return copied_layout


def copy_template_pages(source_template: Template, target_template: Template, db: Session) -> None:
    page_count_errors = validate_template_page_count(len(source_template.pages))
    if page_count_errors:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "invalid_template_page_snapshot",
                "message": page_count_errors[0]["message"],
            },
        )
    # 先全量驗證，避免複製到一半才發現危險版面，留下未綁定的素材 key。
    source_pages_with_layouts = [
        (
            source_page,
            normalize_template_page_layout(json.loads(source_page.layout_json)),
        )
        for source_page in source_template.pages
    ]
    storage = get_storage()
    for source_page, source_layout in source_pages_with_layouts:
        layout = _copy_layout_sticker_assets(
            source_layout,
            source_template.id,
            target_template.id,
            storage,
        )
        layout.pop("background_filename", None)
        target_page = TemplatePage(
            template_id=target_template.id,
            page_number=source_page.page_number,
            layout_json=json.dumps(layout),
        )
        db.add(target_page)
        db.flush()

        if source_page.background_filename:
            target_key = get_background_key(
                target_template.id, target_page.id,
                posixpath.basename(source_page.background_filename),
            )
            if _copy_storage_key(storage, source_page.background_filename, target_key):
                target_page.background_filename = target_key
                layout["background_filename"] = target_key
                target_page.layout_json = json.dumps(layout)
