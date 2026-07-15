import hashlib
import json
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import cast

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import Project, SessionLocal, Student, Template, TemplatePage, TemplateProjectSyncBackup, init_db
from services.student_render_service import _RENDER_PIPELINE_FILES, _render_pipeline_fingerprint
from services.template_project_sync_service import (
    ProjectSyncState,
    StudentSyncState,
    TemplateSyncImpact,
    TemplateSyncPlan,
    _backup_structural_change,
    _change_hash,
    _project_labels_by_page_id,
    _student_entries_by_page_id,
    prepare_template_sync_plan,
    require_structural_sync_confirmation,
)
from tests.helpers import unique_name


LEGACY_RENDER_FINGERPRINT = "8a8fab3a5aed60264619"


def _impact() -> TemplateSyncImpact:
    return TemplateSyncImpact(
        project_count=1,
        student_count=2,
        completed_project_count=3,
        reopen_project_count=4,
        archived_project_count=5,
        added_page_count=6,
        deleted_page_count=7,
        reordered_page_count=8,
        added_photo_slot_count=9,
        removed_photo_slot_count=10,
        added_label_count=11,
        removed_label_count=12,
        affected_photo_count=13,
        affected_project_label_count=14,
        affected_student_label_count=15,
        affected_skip_count=16,
        legacy_orphan_entry_count=17,
        change_summary=["新增 6 頁", "照片格 +9 / -10"],
    )


def test_duplicate_student_page_identity_is_last_wins_and_preserves_previous_entry_as_orphan():
    old_pages = [
        TemplatePage(id=101, template_id=7, page_number=0, layout_json="{}"),
        TemplatePage(id=202, template_id=7, page_number=1, layout_json="{}"),
    ]
    first_entry = {
        "page_index": 0,
        "photos": {"first": {"path": "first.jpg"}},
        "marker": "first",
    }
    last_entry = {
        "template_page_id": "101",
        "page_index": 99,
        "photos": {"last": {"path": "last.jpg"}},
        "marker": "last",
    }
    pages_data = [first_entry, {"page_index": 1, "marker": "second-page"}, last_entry]
    original_pages_data = deepcopy(pages_data)

    entries, old_indices, orphans = _student_entries_by_page_id(
        pages_data,
        old_pages,
        project_id=303,
        student_id=404,
    )

    assert entries == {
        101: last_entry,
        202: {"page_index": 1, "marker": "second-page"},
    }
    assert old_indices == {101: 0, 202: 1}
    assert orphans == [first_entry]
    assert pages_data == original_pages_data


def test_project_label_index_coercion_collision_is_last_wins_and_orphans_previous_value():
    old_pages = [
        TemplatePage(id=101, template_id=7, page_number=0, layout_json="{}"),
        TemplatePage(id=202, template_id=7, page_number=1, layout_json="{}"),
    ]
    first_value = {"label": "first"}
    last_value = {"label": "last"}
    out_of_range_value = {"label": "out-of-range"}

    labels_by_page_id, orphan_labels = _project_labels_by_page_id(
        {"0": first_value, "00": last_value, "2": out_of_range_value},
        old_pages,
        project_id=303,
    )

    assert labels_by_page_id == {101: last_value}
    assert orphan_labels == {
        "00": first_value,
        "2": out_of_range_value,
    }


def test_prepare_plan_preserves_raw_project_and_student_json_byte_for_byte():
    init_db()
    raw_labels_json = ' {\n  "00" : {"label":"專案原文"}\n } '
    raw_pages_json = (
        '[ { "page_index" : 0, "photos" : {}, '
        '"label_texts" : {"label":"學生原文"}, "custom" : true } ]'
    )
    layout = {"photo_slots": [], "text_labels": [], "stickers": []}
    db = SessionLocal()
    try:
        template = Template(name=unique_name("typed_raw_template"), revision=4)
        db.add(template)
        db.flush()
        page = TemplatePage(
            template_id=template.id,
            page_number=0,
            layout_json=json.dumps(layout),
        )
        db.add(page)
        db.flush()
        project = Project(
            name=unique_name("typed_raw_project"),
            template_id=template.id,
            template_revision=4,
            label_texts_json=raw_labels_json,
        )
        db.add(project)
        db.flush()
        db.add(Student(
            project_id=project.id,
            name="原始 JSON 學生",
            order_index=0,
            pages_data_json=raw_pages_json,
        ))
        db.commit()

        template = db.get(Template, template.id)
        old_pages = list(template.pages)
        normalized_items = [
            {"id": page.id, "client_id": None, "layout": deepcopy(layout)},
            {
                "id": None,
                "client_id": "new-page",
                "layout": {"photo_slots": [], "text_labels": [], "stickers": []},
            },
        ]

        plan = prepare_template_sync_plan(template, old_pages, normalized_items, db)

        project_state = plan.project_states[0]
        assert project_state.raw_labels_json == raw_labels_json
        assert project_state.student_states[0].raw_pages_json == raw_pages_json
        assert project_state.labels_by_page_id == {page.id: {"label": "專案原文"}}
        assert project_state.student_states[0].entries_by_page_id[page.id]["custom"] is True
    finally:
        db.close()


def test_impact_and_confirmation_response_keep_the_complete_existing_shape():
    impact = _impact()
    expected_impact = {
        "project_count": 1,
        "student_count": 2,
        "completed_project_count": 3,
        "reopen_project_count": 4,
        "archived_project_count": 5,
        "added_page_count": 6,
        "deleted_page_count": 7,
        "reordered_page_count": 8,
        "added_photo_slot_count": 9,
        "removed_photo_slot_count": 10,
        "added_label_count": 11,
        "removed_label_count": 12,
        "affected_photo_count": 13,
        "affected_project_label_count": 14,
        "affected_student_label_count": 15,
        "affected_skip_count": 16,
        "legacy_orphan_entry_count": 17,
        "change_summary": ["新增 6 頁", "照片格 +9 / -10"],
    }
    project = Project(id=303, name="impact", template_id=7, label_texts_json="{}")
    plan = TemplateSyncPlan(
        project_states=[ProjectSyncState(
            project=project,
            raw_labels_json="{}",
            student_states=[],
        )],
        page_deltas_by_id={},
        old_pages_snapshot=[],
        structural_change=True,
        render_changed=True,
        any_change=True,
        change_hash="bound-change-hash",
        impact=impact,
    )

    assert impact.to_response_dict() == expected_impact
    with pytest.raises(HTTPException) as captured:
        require_structural_sync_confirmation(
            plan,
            confirmed=False,
            supplied_change_hash=None,
        )

    assert captured.value.status_code == 409
    assert captured.value.detail == {
        "code": "template_structure_confirmation_required",
        "message": "這次修改會改變既有專案結構，確認影響範圍後才能同步儲存。",
        "change_hash": "bound-change-hash",
        **expected_impact,
    }


def test_change_hash_is_stable_and_binds_raw_json_and_normalized_page_payloads():
    template = Template(id=7, name="hash", revision=4)
    project = Project(
        id=303,
        name="hash project",
        template_id=7,
        completed_at=None,
        deleted_at=None,
        label_texts_json=' {"0":{"label":"raw"}} ',
    )
    student = Student(
        id=404,
        project_id=303,
        name="hash student",
        pages_data_json='[ {"page_index":0} ]',
    )
    student_state = StudentSyncState(
        student=student,
        raw_pages_json=student.pages_data_json,
    )
    project_state = ProjectSyncState(
        project=project,
        raw_labels_json=project.label_texts_json,
        student_states=[student_state],
    )
    normalized_items = [{
        "id": 101,
        "client_id": None,
        "layout": {"canvas_width": 794, "photo_slots": []},
    }]
    expected_payload = {
        "template_id": 7,
        "revision": 4,
        "pages": [{
            "id": 101,
            "client_id": None,
            "layout": {"canvas_width": 794, "photo_slots": []},
        }],
        "projects": [{
            "id": 303,
            "completed_at": "None",
            "deleted_at": "None",
            "labels": ' {"0":{"label":"raw"}} ',
            "students": [{"id": 404, "pages": '[ {"page_index":0} ]'}],
        }],
    }
    expected_hash = hashlib.sha256(
        json.dumps(
            expected_payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    first_hash = _change_hash(template, normalized_items, [project_state])
    assert first_hash == expected_hash
    assert _change_hash(template, normalized_items, [project_state]) == first_hash

    student_state.raw_pages_json = '[ {"page_index":0} ] '
    assert _change_hash(template, normalized_items, [project_state]) != first_hash
    student_state.raw_pages_json = student.pages_data_json
    changed_items = deepcopy(normalized_items)
    changed_items[0]["layout"]["canvas_width"] = 795
    assert _change_hash(template, changed_items, [project_state]) != first_hash


class _RecordingSession:
    def __init__(self):
        self.added: list[object] = []

    def add(self, value: object) -> None:
        self.added.append(value)


def test_structural_backup_keeps_exact_manual_rescue_payloads():
    completed_at = datetime(2026, 7, 15, 9, 30, 0)
    student_updated_at = datetime(2026, 7, 15, 8, 45, 0)
    raw_labels_json = ' {"0":{"label":"專案原文"}} '
    raw_pages_json = '[ {"page_index":0,"custom":"學生原文"} ]'
    template = Template(id=7, name="backup", revision=4)
    project = Project(
        id=303,
        name="backup project",
        template_id=7,
        completed_at=completed_at,
        label_texts_json=raw_labels_json,
    )
    student = Student(
        id=404,
        project_id=303,
        name="backup student",
        pages_data_json=raw_pages_json,
        output_filename="projects/proj303/students/stu404/album_screen.pdf",
        updated_at=student_updated_at,
    )
    project_state = ProjectSyncState(
        project=project,
        raw_labels_json=raw_labels_json,
        student_states=[StudentSyncState(
            student=student,
            raw_pages_json=raw_pages_json,
        )],
    )
    old_pages_snapshot = [{
        "id": 101,
        "page_number": 0,
        "background_filename": "templates/tpl7/page101.jpg",
        "layout": {"photo_slots": [{"id": 11}]},
    }]
    plan = TemplateSyncPlan(
        project_states=[project_state],
        page_deltas_by_id={},
        old_pages_snapshot=old_pages_snapshot,
        structural_change=True,
        render_changed=True,
        any_change=True,
        change_hash="unused-by-backup",
        impact=_impact(),
    )
    ordered_pages = [
        TemplatePage(id=202, template_id=7, page_number=0, layout_json="{}"),
        TemplatePage(id=101, template_id=7, page_number=1, layout_json="{}"),
    ]
    recording_session = _RecordingSession()

    sync_id = _backup_structural_change(
        template,
        plan,
        ordered_pages,
        cast(Session, recording_session),
    )

    assert isinstance(sync_id, str) and len(sync_id) == 32
    assert len(recording_session.added) == 1
    backup = recording_session.added[0]
    assert isinstance(backup, TemplateProjectSyncBackup)
    assert backup.sync_id == sync_id
    assert backup.template_id == 7
    assert backup.project_id == 303
    assert backup.old_revision == 4
    assert backup.old_pages_json == json.dumps(old_pages_snapshot, ensure_ascii=False)
    assert backup.new_page_ids_json == json.dumps([202, 101])
    assert backup.project_completed_at == completed_at
    assert backup.project_label_texts_json == raw_labels_json
    assert backup.students_json == json.dumps([{
        "id": 404,
        "pages_data_json": raw_pages_json,
        "output_filename": "projects/proj303/students/stu404/album_screen.pdf",
        "updated_at": student_updated_at.isoformat(),
    }], ensure_ascii=False)


def test_render_pipeline_fingerprint_changed_once_and_tracks_copied_owner_sources(tmp_path: Path):
    current_fingerprint = _render_pipeline_fingerprint()
    assert current_fingerprint != LEGACY_RENDER_FINGERPRINT
    assert _render_pipeline_fingerprint() == current_fingerprint

    copied_sources = []
    for source_path in _RENDER_PIPELINE_FILES:
        copied_path = tmp_path / source_path.name
        copied_path.write_bytes(source_path.read_bytes())
        copied_sources.append(copied_path)
    copied_paths = tuple(copied_sources)
    copied_fingerprint = _render_pipeline_fingerprint(copied_paths)
    assert _render_pipeline_fingerprint(copied_paths) == copied_fingerprint

    traversal_owner = next(
        path for path in copied_paths if path.name == "layout_group_traversal.py"
    )
    traversal_owner.write_bytes(traversal_owner.read_bytes() + b"\n# fingerprint contract mutation\n")
    assert _render_pipeline_fingerprint(copied_paths) != copied_fingerprint
