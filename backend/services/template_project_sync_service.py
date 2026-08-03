"""既有專案跟隨 live template 的安全同步。

模板版面本來就是 live reference；本服務補上頁面結構變更時缺少的 identity remap、
影響確認、舊資料備份與輸出失效。照片 storage key 視為 opaque reference，重排時
只改 DB binding，不搬檔、不刪檔。
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy.orm import Session, selectinload

from database import Project, ProjectStudent, Template, TemplatePage, TemplateProjectSyncBackup, utc_now
from services.layout_group_traversal import iter_layout_render_elements, layout_for_render_fingerprint
from services.layout_group_validation import canonical_id
from services.student_pages import lock_student_page_writes
from services.template_sync_locks import lock_project_content_writes


@dataclass
class TemplatePageDelta:
    page_id: int
    added_photo_ids: set[str]
    removed_photo_ids: set[str]
    added_text_ids: set[str]
    removed_text_ids: set[str]
    deleted_photo_ids: set[str] = field(default_factory=set)
    deleted_text_ids: set[str] = field(default_factory=set)


@dataclass
class StudentSyncState:
    student: ProjectStudent
    raw_pages_json: str | None
    entries_by_page_id: dict[int, dict] = field(default_factory=dict)
    old_indices: dict[int, int] = field(default_factory=dict)
    orphan_entries: list[object] = field(default_factory=list)


@dataclass
class ProjectSyncState:
    project: Project
    raw_labels_json: str | None
    student_states: list[StudentSyncState]
    labels_by_page_id: dict[int, object] = field(default_factory=dict)
    orphan_labels: dict[str, object] = field(default_factory=dict)


@dataclass
class TemplateSyncImpact:
    project_count: int
    student_count: int
    completed_project_count: int
    reopen_project_count: int
    archived_project_count: int
    added_page_count: int
    deleted_page_count: int
    reordered_page_count: int
    added_photo_slot_count: int
    removed_photo_slot_count: int
    added_label_count: int
    removed_label_count: int
    affected_photo_count: int
    affected_project_label_count: int
    affected_student_label_count: int
    affected_skip_count: int
    legacy_orphan_entry_count: int
    change_summary: list[str]

    def to_response_dict(self) -> dict:
        return {
            "project_count": self.project_count,
            "student_count": self.student_count,
            "completed_project_count": self.completed_project_count,
            "reopen_project_count": self.reopen_project_count,
            "archived_project_count": self.archived_project_count,
            "added_page_count": self.added_page_count,
            "deleted_page_count": self.deleted_page_count,
            "reordered_page_count": self.reordered_page_count,
            "added_photo_slot_count": self.added_photo_slot_count,
            "removed_photo_slot_count": self.removed_photo_slot_count,
            "added_label_count": self.added_label_count,
            "removed_label_count": self.removed_label_count,
            "affected_photo_count": self.affected_photo_count,
            "affected_project_label_count": self.affected_project_label_count,
            "affected_student_label_count": self.affected_student_label_count,
            "affected_skip_count": self.affected_skip_count,
            "legacy_orphan_entry_count": self.legacy_orphan_entry_count,
            "change_summary": self.change_summary,
        }


@dataclass
class TemplateSyncPlan:
    project_states: list[ProjectSyncState]
    page_deltas_by_id: dict[int, TemplatePageDelta]
    old_pages_snapshot: list[dict]
    structural_change: bool
    render_changed: bool
    any_change: bool
    change_hash: str
    impact: TemplateSyncImpact

    @property
    def projects(self) -> list[Project]:
        return [state.project for state in self.project_states]


def _invalid_project_data(message: str, *, project_id: int, student_id: int | None = None):
    detail = {
        "code": "template_project_data_invalid",
        "message": message,
        "project_id": project_id,
    }
    if student_id is not None:
        detail["student_id"] = student_id
    return HTTPException(status_code=422, detail=detail)


def _parse_json(raw: str | None, expected_type, *, field: str, project_id: int, student_id=None):
    try:
        value = json.loads(raw or ("[]" if expected_type is list else "{}"))
    except (TypeError, json.JSONDecodeError) as exc:
        raise _invalid_project_data(
            f"{field} JSON 格式損壞，模板未儲存",
            project_id=project_id,
            student_id=student_id,
        ) from exc
    if not isinstance(value, expected_type):
        raise _invalid_project_data(
            f"{field} 資料格式不正確，模板未儲存",
            project_id=project_id,
            student_id=student_id,
        )
    return value


def _coerce_page_index(value, *, field: str, project_id: int, student_id=None) -> int:
    if isinstance(value, bool):
        raise _invalid_project_data(field, project_id=project_id, student_id=student_id)
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise _invalid_project_data(field, project_id=project_id, student_id=student_id)
        page_index = int(value)
    else:
        try:
            page_index = int(value)
        except (TypeError, ValueError) as exc:
            raise _invalid_project_data(field, project_id=project_id, student_id=student_id) from exc
    if page_index < 0:
        raise _invalid_project_data(field, project_id=project_id, student_id=student_id)
    return page_index


def _coerce_template_page_id(
    value,
    *,
    project_id: int,
    student_id: int,
) -> int:
    return _coerce_page_index(
        value,
        field="pages_data_json.template_page_id 格式不正確，模板未儲存",
        project_id=project_id,
        student_id=student_id,
    )


def _student_entries_by_page_id(
    pages_data: list,
    old_pages: list[TemplatePage],
    *,
    project_id: int,
    student_id: int,
) -> tuple[dict[int, dict], dict[int, int], list[object]]:
    old_ids = {page.id for page in old_pages}
    entries: dict[int, dict] = {}
    old_indices: dict[int, int] = {}
    orphans: list[object] = []
    for list_index, entry in enumerate(pages_data):
        if not isinstance(entry, dict):
            orphans.append(entry)
            continue
        raw_page_id = entry.get("template_page_id")
        if raw_page_id is not None:
            try:
                page_id = _coerce_template_page_id(
                    raw_page_id,
                    project_id=project_id,
                    student_id=student_id,
                )
            except HTTPException:
                orphans.append(entry)
                continue
            if page_id not in old_ids:
                orphans.append(entry)
                continue
            page_index = next(index for index, page in enumerate(old_pages) if page.id == page_id)
        else:
            try:
                page_index = _coerce_page_index(
                    entry.get("page_index", list_index),
                    field="pages_data_json.page_index 格式不正確，模板未儲存",
                    project_id=project_id,
                    student_id=student_id,
                )
            except HTTPException:
                orphans.append(entry)
                continue
            if page_index >= len(old_pages):
                orphans.append(entry)
                continue
            page_id = old_pages[page_index].id
        if page_id in entries:
            # 舊 render 的 page_index map 採 last-wins；保留相同行為，前一筆進備份。
            orphans.append(entries[page_id])
        entries[page_id] = entry
        old_indices[page_id] = page_index
    return entries, old_indices, orphans


def _project_labels_by_page_id(
    labels: dict,
    old_pages: list[TemplatePage],
    *,
    project_id: int,
) -> tuple[dict[int, object], dict[str, object]]:
    result: dict[int, object] = {}
    orphans: dict[str, object] = {}
    for raw_index, value in labels.items():
        try:
            page_index = _coerce_page_index(
                raw_index,
                field="label_texts_json 頁面索引格式不正確，模板未儲存",
                project_id=project_id,
            )
        except HTTPException:
            orphans[str(raw_index)] = value
            continue
        if page_index >= len(old_pages):
            orphans[str(raw_index)] = value
            continue
        page_id = old_pages[page_index].id
        if page_id in result:
            orphans[str(raw_index)] = result[page_id]
        result[page_id] = value
    return result, orphans


def _visible_binding_ids(layout: dict) -> tuple[set[str], set[str]]:
    photo_ids: set[str] = set()
    label_ids: set[str] = set()
    for element_type, element, _ in iter_layout_render_elements(layout):
        if element_type not in {"photo", "text"}:
            continue
        element_id = canonical_id(element.get("id"))
        (photo_ids if element_type == "photo" else label_ids).add(element_id)
    return photo_ids, label_ids


def _all_binding_ids(layout: dict) -> tuple[set[str], set[str]]:
    """取得實際仍存在的 binding；visible=false 只是隱藏，不代表刪除。"""
    result: list[set[str]] = [set(), set()]
    for result_index, collection_name in enumerate(("photo_slots", "text_labels")):
        collection = layout.get(collection_name, [])
        if not isinstance(collection, list):
            continue
        for element in collection:
            if isinstance(element, dict) and element.get("id") is not None:
                result[result_index].add(canonical_id(element["id"]))
    return result[0], result[1]


def _content_counts(entry: dict | None) -> tuple[int, int, int]:
    if not entry:
        return 0, 0, 0
    photos = entry.get("photos") or {}
    labels = entry.get("label_texts") or {}
    return (
        sum(bool(value) for value in photos.values()) if isinstance(photos, dict) else 0,
        len(labels) if isinstance(labels, dict) else 0,
        int(bool(entry.get("skip"))),
    )


def _change_hash(
    template: Template,
    normalized_items: list[dict],
    project_states: list[ProjectSyncState],
) -> str:
    payload = {
        "template_id": template.id,
        "revision": template.revision,
        "pages": [
            {
                "id": item.get("id"),
                "client_id": item.get("client_id"),
                "layout": item["layout"],
            }
            for item in normalized_items
        ],
        # 確認 token 同時綁住實際受影響資料。確認視窗開啟後若老師又上傳照片、
        # 修改文字或新增專案，retry 必須重新顯示最新 impact，不能沿用舊同意。
        "projects": [
            {
                "id": state.project.id,
                "completed_at": str(state.project.completed_at),
                "deleted_at": str(state.project.deleted_at),
                "labels": state.raw_labels_json,
                "students": [
                    {"id": student_state.student.id, "pages": student_state.raw_pages_json}
                    for student_state in state.student_states
                ],
            }
            for state in project_states
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def prepare_template_sync_plan(
    template: Template,
    old_pages: list[TemplatePage],
    normalized_items: list[dict],
    db: Session,
) -> TemplateSyncPlan:
    """在任何 mutation 前解析全部關聯資料並算出影響，失敗即零寫入。"""
    projects = (
        db.query(Project)
        .options(selectinload(Project.students))
        .execution_options(populate_existing=True)
        .filter(Project.template_id == template.id)
        .order_by(Project.id)
        .all()
    )
    if projects and not normalized_items:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "template_structure_data_conflict",
                "message": "此模板已有既有專案，至少必須保留一頁，否則專案將無法預覽與輸出。",
                "project_count": len(projects),
                "student_count": sum(len(project.students) for project in projects),
            },
        )
    old_page_ids = [page.id for page in old_pages]
    old_index_by_id = {page_id: index for index, page_id in enumerate(old_page_ids)}
    proposed_existing_ids = [item["id"] for item in normalized_items if item.get("id") is not None]
    proposed_tokens = [
        f"id:{item['id']}" if item.get("id") is not None else f"new:{item['client_id']}"
        for item in normalized_items
    ]
    old_tokens = [f"id:{page_id}" for page_id in old_page_ids]
    deleted_ids = set(old_page_ids) - set(proposed_existing_ids)
    added_page_count = sum(item.get("id") is None for item in normalized_items)
    reordered_page_count = sum(
        old_index_by_id[item["id"]] != new_index
        for new_index, item in enumerate(normalized_items)
        if item.get("id") in old_index_by_id
    )

    current_by_id = {page.id: page for page in old_pages}
    page_deltas_by_id: dict[int, TemplatePageDelta] = {}
    render_changed = old_tokens != proposed_tokens
    any_change = render_changed
    added_photo_slots = removed_photo_slots = 0
    added_labels = removed_labels = 0
    for item in normalized_items:
        page_id = item.get("id")
        if page_id is None:
            new_photos, new_labels = _visible_binding_ids(item["layout"])
            added_photo_slots += len(new_photos)
            added_labels += len(new_labels)
            continue
        old_layout = json.loads(current_by_id[page_id].layout_json)
        new_layout = item["layout"]
        if old_layout != new_layout:
            any_change = True
        if layout_for_render_fingerprint(old_layout) != layout_for_render_fingerprint(new_layout):
            render_changed = True
        old_photos, old_labels = _visible_binding_ids(old_layout)
        new_photos, new_labels = _visible_binding_ids(new_layout)
        old_all_photos, old_all_labels = _all_binding_ids(old_layout)
        new_all_photos, new_all_labels = _all_binding_ids(new_layout)
        page_deltas_by_id[page_id] = TemplatePageDelta(
            page_id=page_id,
            removed_photo_ids=old_photos - new_photos,
            removed_text_ids=old_labels - new_labels,
            added_photo_ids=new_photos - old_photos,
            added_text_ids=new_labels - old_labels,
            deleted_photo_ids=old_all_photos - new_all_photos,
            deleted_text_ids=old_all_labels - new_all_labels,
        )
        removed_photo_slots += len(
            (old_photos - new_photos) | (old_all_photos - new_all_photos)
        )
        removed_labels += len(
            (old_labels - new_labels) | (old_all_labels - new_all_labels)
        )
        added_photo_slots += len(new_photos - old_photos)
        added_labels += len(new_labels - old_labels)

    structural_change = (
        old_tokens != proposed_tokens
        or any(
            binding_ids
            for page_delta in page_deltas_by_id.values()
            for binding_ids in (
                page_delta.removed_photo_ids,
                page_delta.removed_text_ids,
                page_delta.added_photo_ids,
                page_delta.added_text_ids,
                page_delta.deleted_photo_ids,
                page_delta.deleted_text_ids,
            )
        )
    )

    project_states: list[ProjectSyncState] = []
    affected_photos = affected_project_labels = affected_student_labels = affected_skips = 0
    legacy_orphan_entries = 0
    for project in projects:
        if not structural_change:
            project_states.append(ProjectSyncState(
                project=project,
                raw_labels_json=project.label_texts_json,
                student_states=[
                    StudentSyncState(
                        student=student,
                        raw_pages_json=student.pages_data_json,
                    )
                    for student in project.students
                ],
            ))
            continue
        labels = _parse_json(
            project.label_texts_json,
            dict,
            field="label_texts_json",
            project_id=project.id,
        )
        labels_by_page_id, orphan_labels = _project_labels_by_page_id(
            labels,
            old_pages,
            project_id=project.id,
        )
        legacy_orphan_entries += len(orphan_labels)
        student_states: list[StudentSyncState] = []
        for student in project.students:
            pages_data = _parse_json(
                student.pages_data_json,
                list,
                field="pages_data_json",
                project_id=project.id,
                student_id=student.id,
            )
            entries_by_page_id, entry_old_indices, orphan_entries = _student_entries_by_page_id(
                pages_data,
                old_pages,
                project_id=project.id,
                student_id=student.id,
            )
            legacy_orphan_entries += len(orphan_entries)
            for page_id in deleted_ids:
                photos, labels_count, skips = _content_counts(entries_by_page_id.get(page_id))
                affected_photos += photos
                affected_student_labels += labels_count
                affected_skips += skips
            for page_id, page_delta in page_deltas_by_id.items():
                entry = entries_by_page_id.get(page_id) or {}
                photos = entry.get("photos") or {}
                student_labels = entry.get("label_texts") or {}
                if isinstance(photos, dict):
                    affected_photos += sum(
                        str(slot_id) in (
                            page_delta.removed_photo_ids | page_delta.deleted_photo_ids
                        )
                        and bool(value)
                        for slot_id, value in photos.items()
                    )
                if isinstance(student_labels, dict):
                    affected_student_labels += sum(
                        str(label_id) in (
                            page_delta.removed_text_ids | page_delta.deleted_text_ids
                        )
                        for label_id in student_labels
                    )
            student_states.append(StudentSyncState(
                student=student,
                raw_pages_json=student.pages_data_json,
                entries_by_page_id=entries_by_page_id,
                old_indices=entry_old_indices,
                orphan_entries=orphan_entries,
            ))

        for page_id in deleted_ids:
            page_labels = labels_by_page_id.get(page_id)
            if isinstance(page_labels, dict):
                affected_project_labels += len(page_labels)
            elif page_labels is not None:
                affected_project_labels += 1
        for page_id, page_delta in page_deltas_by_id.items():
            page_labels = labels_by_page_id.get(page_id) or {}
            if isinstance(page_labels, dict):
                affected_project_labels += sum(
                    str(label_id) in (
                        page_delta.removed_text_ids | page_delta.deleted_text_ids
                    )
                    for label_id in page_labels
                )

        project_states.append(ProjectSyncState(
            project=project,
            raw_labels_json=project.label_texts_json,
            labels_by_page_id=labels_by_page_id,
            orphan_labels=orphan_labels,
            student_states=student_states,
        ))

    old_pages_snapshot = [
        {
            "id": page.id,
            "page_number": page.page_number,
            "background_filename": page.background_filename,
            "layout": json.loads(page.layout_json),
        }
        for page in old_pages
    ]
    change_summary = []
    if added_page_count:
        change_summary.append(f"新增 {added_page_count} 頁")
    if deleted_ids:
        change_summary.append(f"刪除 {len(deleted_ids)} 頁")
    if reordered_page_count:
        change_summary.append("調整頁面順序")
    if added_photo_slots or removed_photo_slots:
        change_summary.append(f"照片格 +{added_photo_slots} / -{removed_photo_slots}")
    if added_labels or removed_labels:
        change_summary.append(f"文字欄 +{added_labels} / -{removed_labels}")

    impact = TemplateSyncImpact(
        project_count=len(projects),
        student_count=sum(len(project.students) for project in projects),
        completed_project_count=sum(project.completed_at is not None for project in projects),
        reopen_project_count=(
            sum(project.completed_at is not None for project in projects)
            if added_photo_slots > 0
            else 0
        ),
        archived_project_count=sum(project.deleted_at is not None for project in projects),
        added_page_count=added_page_count,
        deleted_page_count=len(deleted_ids),
        reordered_page_count=reordered_page_count,
        added_photo_slot_count=added_photo_slots,
        removed_photo_slot_count=removed_photo_slots,
        added_label_count=added_labels,
        removed_label_count=removed_labels,
        affected_photo_count=affected_photos,
        affected_project_label_count=affected_project_labels,
        affected_student_label_count=affected_student_labels,
        affected_skip_count=affected_skips,
        legacy_orphan_entry_count=legacy_orphan_entries,
        change_summary=change_summary,
    )
    return TemplateSyncPlan(
        project_states=project_states,
        page_deltas_by_id=page_deltas_by_id,
        old_pages_snapshot=old_pages_snapshot,
        structural_change=structural_change,
        render_changed=render_changed,
        any_change=any_change,
        change_hash=_change_hash(template, normalized_items, project_states),
        impact=impact,
    )


def require_structural_sync_confirmation(
    plan: TemplateSyncPlan,
    *,
    confirmed: bool,
    supplied_change_hash: str | None,
) -> None:
    if not plan.structural_change or not plan.projects:
        return
    if confirmed:
        if supplied_change_hash == plan.change_hash:
            return
        raise HTTPException(
            status_code=409,
            detail={
                "code": "template_structure_data_conflict",
                "message": "確認後專案內容又有更新，請重新檢查最新影響範圍。",
                "change_hash": plan.change_hash,
                **plan.impact.to_response_dict(),
            },
        )
    raise HTTPException(
        status_code=409,
        detail={
            "code": "template_structure_confirmation_required",
            "message": "這次修改會改變既有專案結構，確認影響範圍後才能同步儲存。",
            "change_hash": plan.change_hash,
            **plan.impact.to_response_dict(),
        },
    )


def _backup_structural_change(
    template: Template,
    plan: TemplateSyncPlan,
    ordered_pages: list[TemplatePage],
    db: Session,
) -> str | None:
    if not plan.structural_change:
        return None
    sync_id = uuid4().hex
    old_pages_json = json.dumps(plan.old_pages_snapshot, ensure_ascii=False)
    new_page_ids_json = json.dumps([page.id for page in ordered_pages])
    if not plan.project_states:
        db.add(TemplateProjectSyncBackup(
            sync_id=sync_id,
            template_id=template.id,
            project_id=None,
            old_revision=template.revision,
            old_pages_json=old_pages_json,
            new_page_ids_json=new_page_ids_json,
        ))
        return sync_id
    for project_index, state in enumerate(plan.project_states):
        project = state.project
        students_backup = [
            {
                "id": student_state.student.id,
                "pages_data_json": student_state.raw_pages_json,
                "output_filename": student_state.student.output_filename,
                # 個別完成時間也入備份：同步退回後仍可人工復原對照
                "completed_at": (
                    student_state.student.completed_at.isoformat()
                    if isinstance(student_state.student.completed_at, datetime)
                    else None
                ),
                "updated_at": (
                    student_state.student.updated_at.isoformat()
                    if isinstance(student_state.student.updated_at, datetime)
                    else None
                ),
            }
            for student_state in state.student_states
        ]
        db.add(TemplateProjectSyncBackup(
            sync_id=sync_id,
            template_id=template.id,
            project_id=project.id,
            old_revision=template.revision,
            # 同一 sync batch 只存一次模板快照；其餘 row 只存各專案 payload。
            old_pages_json=old_pages_json if project_index == 0 else "[]",
            new_page_ids_json=new_page_ids_json,
            project_completed_at=project.completed_at,
            project_label_texts_json=state.raw_labels_json,
            students_json=json.dumps(students_backup, ensure_ascii=False),
        ))
    return sync_id


def apply_template_project_sync(
    template: Template,
    plan: TemplateSyncPlan,
    ordered_pages: list[TemplatePage],
    db: Session,
) -> dict:
    """在頁面已 flush、有正式 ID 後，重綁既有專案並遞增 revision。"""
    if not plan.any_change:
        return {
            "project_count": len(plan.projects),
            "student_count": plan.impact.student_count,
            "migrated_page_entry_count": 0,
            "created_page_entry_count": 0,
            "removed_page_entry_count": 0,
            "invalidated_output_count": 0,
            "reopened_project_count": 0,
            "backup_id": None,
        }

    now = utc_now()
    next_revision = int(template.revision or 1) + 1
    backup_id = _backup_structural_change(template, plan, ordered_pages, db)
    new_index_by_id = {page.id: index for index, page in enumerate(ordered_pages)}
    retained_ids = set(new_index_by_id)
    migrated_entries = created_entries = removed_entries = invalidated_outputs = 0
    reopened_projects = 0

    for state in plan.project_states:
        project = state.project
        if plan.structural_change:
            remapped_labels = {}
            for page_id, value in state.labels_by_page_id.items():
                if page_id not in retained_ids:
                    continue
                remapped_value = deepcopy(value)
                page_delta = plan.page_deltas_by_id.get(page_id)
                if isinstance(remapped_value, dict) and page_delta is not None:
                    for label_id in page_delta.deleted_text_ids:
                        remapped_value.pop(label_id, None)
                remapped_labels[str(new_index_by_id[page_id])] = remapped_value
            project.label_texts_json = json.dumps(remapped_labels, ensure_ascii=False)
        project.template_revision = next_revision
        if plan.render_changed:
            project.updated_at = now
        if (
            plan.impact.added_photo_slot_count > 0
            and project.completed_at is not None
        ):
            project.completed_at = None
            reopened_projects += 1

        for student_state in state.student_states:
            student = student_state.student
            # 新照片格對每一本都是缺格：學生個別完成與全班完成一併退回
            if plan.impact.added_photo_slot_count > 0:
                student.completed_at = None
            if plan.structural_change:
                entries = student_state.entries_by_page_id
                old_indices = student_state.old_indices
                next_pages_data = []
                for new_index, page in enumerate(ordered_pages):
                    source = entries.get(page.id)
                    if source is None:
                        source = {"photos": {}, "label_texts": {}}
                        created_entries += 1
                    elif old_indices.get(page.id) != new_index:
                        migrated_entries += 1
                    page_entry = deepcopy(source)
                    page_entry["page_index"] = new_index
                    page_entry["template_page_id"] = page.id
                    page_entry.setdefault("photos", {})
                    page_entry.setdefault("label_texts", {})
                    page_delta = plan.page_deltas_by_id.get(page.id)
                    if page_delta is not None:
                        photos = page_entry.get("photos")
                        if isinstance(photos, dict):
                            for slot_id in page_delta.deleted_photo_ids:
                                photos.pop(slot_id, None)
                        label_texts = page_entry.get("label_texts")
                        if isinstance(label_texts, dict):
                            for label_id in page_delta.deleted_text_ids:
                                label_texts.pop(label_id, None)
                    next_pages_data.append(page_entry)
                removed_entries += sum(page_id not in retained_ids for page_id in entries)
                student.pages_data_json = json.dumps(next_pages_data, ensure_ascii=False)
            if plan.render_changed:
                if student.output_filename:
                    invalidated_outputs += 1
                student.output_filename = None
                student.updated_at = now

    template.revision = next_revision
    return {
        "project_count": len(plan.projects),
        "student_count": plan.impact.student_count,
        "migrated_page_entry_count": migrated_entries,
        "created_page_entry_count": created_entries,
        "removed_page_entry_count": removed_entries,
        "invalidated_output_count": invalidated_outputs,
        "reopened_project_count": reopened_projects,
        "backup_id": backup_id,
    }


def commit_direct_template_render_change(
    template: Template,
    db: Session,
    *,
    expected_revision: int,
    apply_template_change: Callable[[], None],
) -> dict:
    """背景等無法走 JSON snapshot 的像素變更：同步 revision、失效輸出後 commit。

    呼叫端必須持有 lock_template_write，並已把 TemplatePage mutation 放進同一 session。
    """
    projects = (
        db.query(Project)
        .options(selectinload(Project.students))
        .filter(Project.template_id == template.id)
        .order_by(Project.id)
        .all()
    )
    project_ids = [project.id for project in projects]
    student_ids = [student.id for project in projects for student in project.students]
    with lock_project_content_writes(project_ids), lock_student_page_writes(student_ids):
        # 等待鎖時內容可能完成一次寫入；結束舊 WAL snapshot 後才套用尚未
        # 寫入 session 的模板資產變更，避免 rollback 把它一併撤銷。
        db.rollback()
        db.expire_all()
        db.refresh(template)
        if template.revision != expected_revision:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "template_revision_changed",
                    "message": "模板已被其他操作更新，請重新整理後再試",
                    "current_revision": template.revision,
                },
            )
        projects = (
            db.query(Project)
            .options(selectinload(Project.students))
            .execution_options(populate_existing=True)
            .filter(Project.template_id == template.id)
            .order_by(Project.id)
            .all()
        )
        apply_template_change()
        now = utc_now()
        next_revision = int(template.revision or 1) + 1
        invalidated_outputs = 0
        for project in projects:
            project.template_revision = next_revision
            project.updated_at = now
            for student in project.students:
                if student.output_filename:
                    invalidated_outputs += 1
                student.output_filename = None
                student.updated_at = now
        template.revision = next_revision
        try:
            db.commit()
        except Exception:
            db.rollback()
            raise
    return {
        "project_count": len(projects),
        "student_count": sum(len(project.students) for project in projects),
        "migrated_page_entry_count": 0,
        "created_page_entry_count": 0,
        "removed_page_entry_count": 0,
        "invalidated_output_count": invalidated_outputs,
        "reopened_project_count": 0,
        "backup_id": None,
    }
