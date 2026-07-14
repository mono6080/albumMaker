# 模板頁面快照服務
# 將頁面新增、刪除、排序與版面更新放在同一個資料庫 transaction 中。

import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import Template, TemplatePage
from services.layout_groups import validate_layout_groups
from services.student_pages import lock_student_page_writes
from services.template_project_sync_service import (
    apply_template_project_sync,
    prepare_template_sync_plan,
    require_structural_sync_confirmation,
)
from services.template_sync_locks import lock_project_content_writes, lock_template_write


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
    *,
    expected_revision: int | None = None,
    confirm_project_sync: bool = False,
    project_sync_change_hash: str | None = None,
) -> dict:
    """以完整快照原子取代模板頁面，並回傳 client_id 到資料庫 id 的對應。"""
    with lock_template_write(template.id):
        # 同一位使用者可能開兩個編輯器；拿到模板鎖後必須重新讀 DB，不能沿用
        # route dependency 建立時的 SQLite read transaction／identity-map 快照。
        db.rollback()
        db.expire_all()
        db.refresh(template)
        db.expire(template, ["pages"])
        if expected_revision is not None and expected_revision != template.revision:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "template_revision_changed",
                    "expected_revision": expected_revision,
                    "actual_revision": template.revision,
                },
            )

        current_pages, normalized_items = _validate_snapshot(template, expected_page_ids, page_items)
        initial_plan = prepare_template_sync_plan(template, current_pages, normalized_items, db)
        require_structural_sync_confirmation(
            initial_plan,
            confirmed=confirm_project_sync,
            supplied_change_hash=project_sync_change_hash,
        )
        project_ids = [project.id for project in initial_plan.projects]
        student_ids = [
            student.id
            for project in initial_plan.projects
            for student in project.students
        ]

        with lock_project_content_writes(project_ids), lock_student_page_writes(student_ids):
            # 第一次 prepare 已開啟 SQLite WAL read snapshot；等待內容鎖後必須先
            # 結束舊 transaction，否則 populate_existing 仍可能讀到等待前的版本。
            db.rollback()
            db.expire_all()
            db.refresh(template)
            db.expire(template, ["pages"])
            if expected_revision is not None and expected_revision != template.revision:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "template_revision_changed",
                        "expected_revision": expected_revision,
                        "actual_revision": template.revision,
                    },
                )
            current_pages, normalized_items = _validate_snapshot(
                template,
                expected_page_ids,
                page_items,
            )
            # 重新 prepare 取得鎖內最新 JSON，確保 remap 與 confirmation hash
            # 不會把等待期間完成的內容／名單／狀態寫入蓋回舊值。
            plan = prepare_template_sync_plan(template, current_pages, normalized_items, db)
            require_structural_sync_confirmation(
                plan,
                confirmed=confirm_project_sync,
                supplied_change_hash=project_sync_change_hash,
            )
            current_by_id = {page.id: page for page in current_pages}
            retained_ids = {
                item["id"]
                for item in normalized_items
                if item.get("id") is not None
            }
            deleted_pages = [page for page in current_pages if page.id not in retained_ids]

            try:
                # 先搬到不衝突的暫存頁碼，避免重排時撞到複合 UNIQUE index。
                temporary_start = min(
                    [page.page_number for page in current_pages] + [0]
                ) - len(current_pages) - 1
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

                # 新頁必須先 flush 取得正式 TemplatePage.id，專案 JSON 才能寫穩定 identity。
                db.flush()
                sync_result = apply_template_project_sync(
                    template,
                    plan,
                    [page for page, _ in ordered_pages],
                    db,
                )
                response_revision = template.revision
                response_pages = [
                    _serialize_snapshot_page(page, client_id)
                    for page, client_id in ordered_pages
                ]
                db.commit()
            except Exception:
                db.rollback()
                raise

        # 刪頁背景刻意不在這裡清除：結構備份保留其 key，照片與背景資產皆採
        # post-commit retention，避免 DB 可復原但檔案已先被刪掉。
        return {
            "revision": response_revision,
            "pages": response_pages,
            "sync": sync_result,
        }
