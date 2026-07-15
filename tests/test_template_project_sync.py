# 已上線模板同步契約：確認、identity remap、版本、備份與原子 rollback

import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import deepcopy
from threading import Event

import pytest

from database import (
    Project,
    SessionLocal,
    Student,
    Template,
    TemplatePage,
    TemplateProjectSyncBackup,
    init_db,
)
from services import project_student_service, template_page_snapshot_service
from services.template_project_sync_service import (
    ProjectSyncState,
    StudentSyncState,
    TemplatePageDelta,
    TemplateSyncImpact,
    TemplateSyncPlan,
    prepare_template_sync_plan,
)
from services.template_sync_locks import lock_project_content_writes
from tests.helpers import assert_status, login, started_client, unique_name


def _layout(seed: int) -> dict:
    return {
        "canvas_width": 794,
        "canvas_height": 1123,
        "photo_slots": [
            {
                "id": seed * 10 + 1,
                "x": 40 + seed,
                "y": 80 + seed,
                "width": 240,
                "height": 180,
                "border": True,
                "border_width": 8,
            }
        ],
        "text_labels": [
            {
                "id": seed * 10 + 2,
                "x": 90 + seed,
                "y": 340 + seed,
                "width": 360,
                "height": 96,
                "text": f"第 {seed} 頁文字",
                "font_size": 24,
                "font_color": "#333333",
            }
        ],
        "stickers": [],
        "footer": None,
        "logo": None,
    }


def _seed_linked_template(page_count: int = 3) -> dict:
    db = SessionLocal()
    try:
        template = Template(name=unique_name("sync_template"), revision=1)
        db.add(template)
        db.flush()

        layouts = [_layout(page_index + 1) for page_index in range(page_count)]
        pages = [
            TemplatePage(
                template_id=template.id,
                page_number=page_index,
                layout_json=json.dumps(layout),
            )
            for page_index, layout in enumerate(layouts)
        ]
        db.add_all(pages)
        db.flush()

        project_labels = {
            str(page_index): {
                str(layouts[page_index]["text_labels"][0]["id"]): f"專案文字 {page_index}",
            }
            for page_index in range(page_count)
        }
        project = Project(
            name=unique_name("sync_project"),
            template_id=template.id,
            template_revision=1,
            label_texts_json=json.dumps(project_labels, ensure_ascii=False),
        )
        db.add(project)
        db.flush()

        student = Student(
            project_id=project.id,
            name="同步測試學生",
            order_index=0,
            pages_data_json="[]",
        )
        db.add(student)
        db.flush()

        page_entries = []
        photo_paths = []
        for page_index, layout in enumerate(layouts):
            slot_id = layout["photo_slots"][0]["id"]
            label_id = layout["text_labels"][0]["id"]
            photo_path = (
                f"projects/proj{project.id}/students/stu{student.id}/"
                f"page{page_index}_slot{slot_id}.jpg"
            )
            photo_paths.append(photo_path)
            page_entries.append({
                "page_index": page_index,
                "photos": {
                    str(slot_id): {
                        "path": photo_path,
                        "offset_x": page_index + 0.25,
                        "scale": 1.1 + page_index / 10,
                    }
                },
                "label_texts": {str(label_id): f"學生文字 {page_index}"},
                "skip": page_index % 2 == 1,
                "test_marker": f"page-{page_index}",
            })
        student.pages_data_json = json.dumps(page_entries, ensure_ascii=False)
        student.output_filename = (
            f"projects/proj{project.id}/students/stu{student.id}/album_screen.pdf"
        )
        db.commit()

        return {
            "template_id": template.id,
            "project_id": project.id,
            "student_id": student.id,
            "page_ids": [page.id for page in pages],
            "layouts": layouts,
            "project_labels": project_labels,
            "page_entries": page_entries,
            "photo_paths": photo_paths,
            "output_filename": student.output_filename,
        }
    finally:
        db.close()


def _snapshot_payload(
    seeded: dict,
    pages: list[dict],
    *,
    expected_revision: int = 1,
    confirm_project_sync: bool = False,
    project_sync_change_hash: str | None = None,
) -> dict:
    payload = {
        "expected_page_ids": seeded["page_ids"],
        "expected_revision": expected_revision,
        "confirm_project_sync": confirm_project_sync,
        "pages": pages,
    }
    if project_sync_change_hash is not None:
        payload["project_sync_change_hash"] = project_sync_change_hash
    return payload


def _database_snapshot(template_id: int, project_id: int, student_id: int) -> dict:
    db = SessionLocal()
    try:
        template = db.query(Template).filter(Template.id == template_id).one()
        project = db.query(Project).filter(Project.id == project_id).one()
        student = db.query(Student).filter(Student.id == student_id).one()
        pages = (
            db.query(TemplatePage)
            .filter(TemplatePage.template_id == template_id)
            .order_by(TemplatePage.page_number)
            .all()
        )
        return {
            "template_revision": template.revision,
            "pages": [
                (page.id, page.page_number, page.layout_json, page.background_filename)
                for page in pages
            ],
            "project_revision": project.template_revision,
            "project_labels": project.label_texts_json,
            "project_updated_at": project.updated_at,
            "student_pages": student.pages_data_json,
            "student_output": student.output_filename,
            "student_updated_at": student.updated_at,
            "backup_count": (
                db.query(TemplateProjectSyncBackup)
                .filter(TemplateProjectSyncBackup.template_id == template_id)
                .count()
            ),
        }
    finally:
        db.close()


def test_template_sync_plan_uses_typed_nested_state_without_changing_raw_payloads():
    init_db()
    seeded = _seed_linked_template(page_count=2)
    db = SessionLocal()
    try:
        template = db.get(Template, seeded["template_id"])
        old_pages = list(template.pages)
        first_layout = deepcopy(seeded["layouts"][0])
        first_layout["photo_slots"] = []
        normalized_items = [
            {"id": old_pages[0].id, "client_id": None, "layout": first_layout},
            {"id": old_pages[1].id, "client_id": None, "layout": seeded["layouts"][1]},
        ]

        plan = prepare_template_sync_plan(template, old_pages, normalized_items, db)

        assert isinstance(plan, TemplateSyncPlan)
        assert isinstance(plan.impact, TemplateSyncImpact)
        assert isinstance(plan.project_states[0], ProjectSyncState)
        assert isinstance(plan.project_states[0].student_states[0], StudentSyncState)
        assert isinstance(plan.page_deltas_by_id[old_pages[0].id], TemplatePageDelta)
        assert plan.page_deltas_by_id[old_pages[0].id].removed_photo_ids == {
            str(seeded["layouts"][0]["photo_slots"][0]["id"])
        }
        assert plan.project_states[0].raw_labels_json == json.dumps(
            seeded["project_labels"],
            ensure_ascii=False,
        )
        assert plan.project_states[0].student_states[0].raw_pages_json == json.dumps(
            seeded["page_entries"],
            ensure_ascii=False,
        )
        assert plan.impact.to_response_dict()["affected_photo_count"] == 1
    finally:
        db.close()


def _existing_page_item(page_id: int, layout: dict) -> dict:
    return {"id": page_id, "layout": deepcopy(layout)}


def test_structural_sync_requires_bound_hash_then_remaps_by_template_page_id():
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template()
        assert_status(client.post(f"/api/projects/{seeded['project_id']}/complete"), 200)
        completed_db = SessionLocal()
        try:
            original_completed_at = completed_db.get(
                Project,
                seeded["project_id"],
            ).completed_at
        finally:
            completed_db.close()
        assert original_completed_at is not None
        first_page_id, deleted_page_id, third_page_id = seeded["page_ids"]
        structural_pages = [
            _existing_page_item(third_page_id, seeded["layouts"][2]),
            {"client_id": "new-middle-page", "layout": _layout(9)},
            _existing_page_item(first_page_id, seeded["layouts"][0]),
        ]
        initial_state = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )

        confirmation = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(seeded, structural_pages),
        )
        assert_status(confirmation, 409)
        confirmation_detail = confirmation.json()["detail"]
        assert confirmation_detail["code"] == "template_structure_confirmation_required"
        assert confirmation_detail["project_count"] == 1
        assert confirmation_detail["student_count"] == 1
        assert confirmation_detail["added_page_count"] == 1
        assert confirmation_detail["deleted_page_count"] == 1
        assert confirmation_detail["reordered_page_count"] >= 1
        assert confirmation_detail["completed_project_count"] == 1
        assert confirmation_detail["reopen_project_count"] == 1
        assert len(confirmation_detail["change_hash"]) == 64
        assert _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        ) == initial_state

        wrong_hash = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                structural_pages,
                confirm_project_sync=True,
                project_sync_change_hash="0" * 64,
            ),
        )
        assert_status(wrong_hash, 409)
        assert wrong_hash.json()["detail"]["change_hash"] == confirmation_detail["change_hash"]
        assert _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        ) == initial_state

        confirmed = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                structural_pages,
                confirm_project_sync=True,
                project_sync_change_hash=confirmation_detail["change_hash"],
            ),
        )
        assert_status(confirmed, 200)
        confirmed_payload = confirmed.json()
        new_page_id = next(
            page["id"]
            for page in confirmed_payload["pages"]
            if page["client_id"] == "new-middle-page"
        )
        assert confirmed_payload["revision"] == 2
        assert [page["id"] for page in confirmed_payload["pages"]] == [
            third_page_id,
            new_page_id,
            first_page_id,
        ]
        assert deleted_page_id not in [page["id"] for page in confirmed_payload["pages"]]

        db = SessionLocal()
        try:
            template = db.query(Template).filter(Template.id == seeded["template_id"]).one()
            project = db.query(Project).filter(Project.id == seeded["project_id"]).one()
            student = db.query(Student).filter(Student.id == seeded["student_id"]).one()
            assert template.revision == project.template_revision == 2
            assert project.completed_at is None
            assert confirmed_payload["sync"]["reopened_project_count"] == 1
            assert json.loads(project.label_texts_json) == {
                "0": seeded["project_labels"]["2"],
                "2": seeded["project_labels"]["0"],
            }

            remapped_entries = json.loads(student.pages_data_json)
            assert len(remapped_entries) == 3
            assert remapped_entries[0] == {
                **seeded["page_entries"][2],
                "page_index": 0,
                "template_page_id": third_page_id,
            }
            assert remapped_entries[1] == {
                "photos": {},
                "label_texts": {},
                "page_index": 1,
                "template_page_id": new_page_id,
            }
            assert remapped_entries[2] == {
                **seeded["page_entries"][0],
                "page_index": 2,
                "template_page_id": first_page_id,
            }
            assert remapped_entries[0]["photos"]["31"]["path"] == seeded["photo_paths"][2]
            assert remapped_entries[2]["photos"]["11"]["path"] == seeded["photo_paths"][0]
            assert student.output_filename is None

            backup_id = confirmed_payload["sync"]["backup_id"]
            assert backup_id
            backup = (
                db.query(TemplateProjectSyncBackup)
                .filter(
                    TemplateProjectSyncBackup.sync_id == backup_id,
                    TemplateProjectSyncBackup.project_id == project.id,
                )
                .one()
            )
            assert backup.old_revision == 1
            assert backup.project_completed_at == original_completed_at
            assert [page["id"] for page in json.loads(backup.old_pages_json)] == seeded["page_ids"]
            assert json.loads(backup.new_page_ids_json) == [third_page_id, new_page_id, first_page_id]
            assert json.loads(backup.project_label_texts_json) == seeded["project_labels"]
            student_backup = json.loads(backup.students_json)[0]
            assert student_backup["output_filename"] == seeded["output_filename"]
            assert json.loads(student_backup["pages_data_json"]) == seeded["page_entries"]
            assert seeded["photo_paths"][1] in student_backup["pages_data_json"]
        finally:
            db.close()


def test_layout_only_change_skips_confirmation_but_invalidates_rendered_output():
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=1)
        moved_layout = deepcopy(seeded["layouts"][0])
        moved_layout["photo_slots"][0]["x"] += 17

        response = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                [_existing_page_item(seeded["page_ids"][0], moved_layout)],
            ),
        )
        assert_status(response, 200)
        assert response.json()["revision"] == 2
        assert response.json()["sync"]["backup_id"] is None
        assert response.json()["sync"]["invalidated_output_count"] == 1

        state = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )
        assert state["template_revision"] == state["project_revision"] == 2
        assert json.loads(state["pages"][0][2]) == moved_layout
        assert state["project_labels"] == json.dumps(seeded["project_labels"], ensure_ascii=False)
        assert state["student_pages"] == json.dumps(seeded["page_entries"], ensure_ascii=False)
        assert state["student_output"] is None
        assert state["backup_count"] == 0


def test_editor_metadata_only_change_advances_revision_without_invalidating_output():
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=1)
        metadata_layout = deepcopy(seeded["layouts"][0])
        metadata_layout["photo_slots"][0]["layer_name"] = "主照片"
        metadata_layout["photo_slots"][0]["locked"] = True
        metadata_layout["text_labels"][0]["layer_name"] = "說明文字"
        metadata_layout["text_labels"][0]["locked"] = True
        before = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )

        response = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                [_existing_page_item(seeded["page_ids"][0], metadata_layout)],
            ),
        )
        assert_status(response, 200)
        assert response.json()["revision"] == 2
        assert response.json()["sync"]["invalidated_output_count"] == 0

        after = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )
        assert after["template_revision"] == after["project_revision"] == 2
        assert json.loads(after["pages"][0][2]) == metadata_layout
        assert after["student_output"] == seeded["output_filename"]
        assert after["student_updated_at"] == before["student_updated_at"]
        assert after["backup_count"] == 0


def test_stale_expected_revision_returns_409_without_any_write():
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=1)
        metadata_layout = deepcopy(seeded["layouts"][0])
        metadata_layout["photo_slots"][0]["locked"] = True
        first_save = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                [_existing_page_item(seeded["page_ids"][0], metadata_layout)],
            ),
        )
        assert_status(first_save, 200)
        before_stale_save = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )

        stale_layout = deepcopy(metadata_layout)
        stale_layout["photo_slots"][0]["x"] += 25
        stale = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                [_existing_page_item(seeded["page_ids"][0], stale_layout)],
                expected_revision=1,
            ),
        )
        assert_status(stale, 409)
        assert stale.json()["detail"] == {
            "code": "template_revision_changed",
            "expected_revision": 1,
            "actual_revision": 2,
        }
        assert _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        ) == before_stale_save


@pytest.mark.parametrize("corrupt_field", ["project", "student"])
def test_corrupt_project_json_rejects_structural_snapshot_without_any_write(corrupt_field: str):
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=1)
        db = SessionLocal()
        try:
            if corrupt_field == "project":
                project = db.query(Project).filter(Project.id == seeded["project_id"]).one()
                project.label_texts_json = "{broken-project-json"
            else:
                student = db.query(Student).filter(Student.id == seeded["student_id"]).one()
                student.pages_data_json = "[broken-student-json"
            db.commit()
        finally:
            db.close()

        before = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )
        changed_layout = deepcopy(seeded["layouts"][0])
        changed_layout["photo_slots"].append({
            "id": 999,
            "x": 400,
            "y": 80,
            "width": 240,
            "height": 180,
            "border": True,
            "border_width": 8,
        })
        rejected = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                [_existing_page_item(seeded["page_ids"][0], changed_layout)],
            ),
        )
        assert_status(rejected, 422)
        assert rejected.json()["detail"]["code"] == "template_project_data_invalid"
        assert _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        ) == before


def test_failure_after_sync_mutations_rolls_back_template_projects_and_backup(monkeypatch):
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=2)
        reordered_pages = [
            _existing_page_item(seeded["page_ids"][1], seeded["layouts"][1]),
            _existing_page_item(seeded["page_ids"][0], seeded["layouts"][0]),
        ]
        confirmation = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(seeded, reordered_pages),
        )
        assert_status(confirmation, 409)
        change_hash = confirmation.json()["detail"]["change_hash"]
        before = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )

        original_apply = template_page_snapshot_service.apply_template_project_sync

        def apply_then_fail(*args, **kwargs):
            original_apply(*args, **kwargs)
            raise RuntimeError("forced template sync failure")

        monkeypatch.setattr(
            template_page_snapshot_service,
            "apply_template_project_sync",
            apply_then_fail,
        )
        with pytest.raises(RuntimeError, match="forced template sync failure"):
            client.put(
                f"/api/templates/{seeded['template_id']}/pages",
                json=_snapshot_payload(
                    seeded,
                    reordered_pages,
                    confirm_project_sync=True,
                    project_sync_change_hash=change_hash,
                ),
            )

        assert _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        ) == before


def test_confirmation_hash_expires_when_affected_student_content_changes():
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=2)
        retained_pages = [
            _existing_page_item(seeded["page_ids"][0], seeded["layouts"][0]),
        ]
        confirmation = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(seeded, retained_pages),
        )
        assert_status(confirmation, 409)
        old_detail = confirmation.json()["detail"]

        db = SessionLocal()
        try:
            student = db.query(Student).filter(Student.id == seeded["student_id"]).one()
            pages_data = json.loads(student.pages_data_json)
            pages_data[1]["photos"]["extra"] = {
                "path": "projects/new-after-confirmation.jpg",
            }
            student.pages_data_json = json.dumps(pages_data)
            db.commit()
        finally:
            db.close()
        after_teacher_edit = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )

        stale_confirmation = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                retained_pages,
                confirm_project_sync=True,
                project_sync_change_hash=old_detail["change_hash"],
            ),
        )
        assert_status(stale_confirmation, 409)
        latest_detail = stale_confirmation.json()["detail"]
        assert latest_detail["code"] == "template_structure_data_conflict"
        assert latest_detail["change_hash"] != old_detail["change_hash"]
        assert latest_detail["affected_photo_count"] == old_detail["affected_photo_count"] + 1
        assert _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        ) == after_teacher_edit


@pytest.mark.parametrize(
    ("lifecycle_change", "impact_field", "before_count", "after_count"),
    [
        ("complete", "completed_project_count", 0, 1),
        ("reopen", "completed_project_count", 1, 0),
        ("add_student", "student_count", 1, 2),
    ],
)
def test_confirmation_hash_expires_when_project_lifecycle_or_student_list_changes(
    lifecycle_change: str,
    impact_field: str,
    before_count: int,
    after_count: int,
):
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=2)
        if lifecycle_change == "reopen":
            assert_status(client.post(f"/api/projects/{seeded['project_id']}/complete"), 200)

        retained_pages = [
            _existing_page_item(seeded["page_ids"][0], seeded["layouts"][0]),
        ]
        confirmation = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(seeded, retained_pages),
        )
        assert_status(confirmation, 409)
        old_detail = confirmation.json()["detail"]
        assert old_detail[impact_field] == before_count

        if lifecycle_change == "complete":
            changed = client.post(f"/api/projects/{seeded['project_id']}/complete")
        elif lifecycle_change == "reopen":
            changed = client.post(f"/api/projects/{seeded['project_id']}/reopen")
        else:
            changed = client.post(
                f"/api/projects/{seeded['project_id']}/students/batch",
                json=["確認後新增學生"],
            )
        assert_status(changed, 200)
        after_lifecycle_change = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )

        stale_confirmation = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                retained_pages,
                confirm_project_sync=True,
                project_sync_change_hash=old_detail["change_hash"],
            ),
        )
        assert_status(stale_confirmation, 409)
        latest_detail = stale_confirmation.json()["detail"]
        assert latest_detail["code"] == "template_structure_data_conflict"
        assert latest_detail["change_hash"] != old_detail["change_hash"]
        assert latest_detail[impact_field] == after_count
        assert _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        ) == after_lifecycle_change


def test_confirmation_retry_rereads_after_waiting_for_project_lock(monkeypatch):
    """拿到 project lock 後必須重讀；等待期間完成的名單寫入會讓舊 hash 失效。"""
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=2)
        retained_pages = [
            _existing_page_item(seeded["page_ids"][0], seeded["layouts"][0]),
        ]
        confirmation = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(seeded, retained_pages),
        )
        assert_status(confirmation, 409)
        old_detail = confirmation.json()["detail"]

        template_waiting_for_project = Event()
        release_student_writer = Event()
        student_writer_holds_project = Event()

        @contextmanager
        def delayed_student_writer_lock(project_ids):
            with lock_project_content_writes(project_ids):
                student_writer_holds_project.set()
                assert release_student_writer.wait(timeout=5)
                yield

        @contextmanager
        def observed_snapshot_lock(project_ids):
            template_waiting_for_project.set()
            with lock_project_content_writes(project_ids):
                yield

        monkeypatch.setattr(
            project_student_service,
            "lock_project_content_writes",
            delayed_student_writer_lock,
        )
        monkeypatch.setattr(
            template_page_snapshot_service,
            "lock_project_content_writes",
            observed_snapshot_lock,
        )

        with ThreadPoolExecutor(max_workers=2) as executor:
            student_write = executor.submit(
                client.post,
                f"/api/projects/{seeded['project_id']}/students/batch",
                json=["等待鎖期間新增學生"],
            )
            try:
                assert student_writer_holds_project.wait(timeout=5)
                stale_retry = executor.submit(
                    client.put,
                    f"/api/templates/{seeded['template_id']}/pages",
                    json=_snapshot_payload(
                        seeded,
                        retained_pages,
                        confirm_project_sync=True,
                        project_sync_change_hash=old_detail["change_hash"],
                    ),
                )
                assert template_waiting_for_project.wait(timeout=5)
            finally:
                release_student_writer.set()

            assert_status(student_write.result(timeout=5), 200)
            stale_response = stale_retry.result(timeout=5)

        assert_status(stale_response, 409)
        latest_detail = stale_response.json()["detail"]
        assert latest_detail["code"] == "template_structure_data_conflict"
        assert latest_detail["change_hash"] != old_detail["change_hash"]
        assert latest_detail["student_count"] == old_detail["student_count"] + 1

        after = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )
        assert after["template_revision"] == 1
        assert [page_id for page_id, *_ in after["pages"]] == seeded["page_ids"]
        assert after["backup_count"] == 0


def test_linked_template_cannot_delete_its_final_page():
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=1)
        before = _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        )

        response = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(seeded, []),
        )
        assert_status(response, 409)
        assert response.json()["detail"]["code"] == "template_structure_data_conflict"
        assert "至少必須保留一頁" in response.json()["detail"]["message"]
        assert _database_snapshot(
            seeded["template_id"], seeded["project_id"], seeded["student_id"]
        ) == before


def test_legacy_out_of_range_page_data_is_backed_up_instead_of_blocking_sync():
    with started_client() as client:
        login(client)
        seeded = _seed_linked_template(page_count=2)
        db = SessionLocal()
        try:
            student = db.query(Student).filter(Student.id == seeded["student_id"]).one()
            pages_data = json.loads(student.pages_data_json)
            pages_data.append({
                "page_index": 99,
                "photos": {},
                "label_texts": {"legacy": "保留我"},
                "legacy_marker": True,
            })
            student.pages_data_json = json.dumps(pages_data, ensure_ascii=False)
            db.commit()
        finally:
            db.close()

        reordered = [
            _existing_page_item(seeded["page_ids"][1], seeded["layouts"][1]),
            _existing_page_item(seeded["page_ids"][0], seeded["layouts"][0]),
        ]
        confirmation = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(seeded, reordered),
        )
        assert_status(confirmation, 409)
        detail = confirmation.json()["detail"]
        assert detail["legacy_orphan_entry_count"] == 1

        applied = client.put(
            f"/api/templates/{seeded['template_id']}/pages",
            json=_snapshot_payload(
                seeded,
                reordered,
                confirm_project_sync=True,
                project_sync_change_hash=detail["change_hash"],
            ),
        )
        assert_status(applied, 200)
        db = SessionLocal()
        try:
            student = db.query(Student).filter(Student.id == seeded["student_id"]).one()
            assert all(page["page_index"] in {0, 1} for page in json.loads(student.pages_data_json))
            backup = (
                db.query(TemplateProjectSyncBackup)
                .filter(TemplateProjectSyncBackup.template_id == seeded["template_id"])
                .order_by(TemplateProjectSyncBackup.id.desc())
                .first()
            )
            assert "legacy_marker" in backup.students_json
        finally:
            db.close()
