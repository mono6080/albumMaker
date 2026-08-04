"""同一個班級期別的兩本相本之間搬移學生，照片與個人文字一起帶走。

相本成員原本是完全凍結的期別快照，DB trigger 只在「同工作格、同模板」這個窄口
放行 project_id——因為那不會讓歷史漂移、身分接錯或匯出重複。
"""

import json

from database import ProjectStudent, SessionLocal
from tests.helpers import (
    _create_classroom_with_lead,
    _find_classroom_work_slot_id,
    assert_status,
    create_template_with_page,
    jpeg_bytes,
    login,
    revisioned_project_url,
    started_client,
    unique_name,
    use_tmp_uploads,
)


def _create_active_template(client, department: str = "infant") -> int:
    period_response = client.post(
        "/api/templates/periods",
        data={
            "name": unique_name("transfer_period"),
            "department": department,
            "status": "active",
        },
    )
    assert_status(period_response, 200)
    template_id, _ = create_template_with_page(
        client, period_id=period_response.json()["id"]
    )
    return template_id


def _setup_two_albums(client, student_names):
    """在同一個工作格建兩本相本：第一本收全部，第二本先收最後一位。"""
    template_id = _create_active_template(client)
    classroom_id, lead_teacher_id, _ = _create_classroom_with_lead(
        client, template_id, student_names=student_names
    )
    work_slot_id = _find_classroom_work_slot_id(client, classroom_id, template_id)
    overview = client.get("/api/organization/overview")
    assert_status(overview, 200)
    members = next(
        classroom["members"]
        for campus in overview.json()["campuses"]
        for classroom in campus["classrooms"]
        if classroom["id"] == classroom_id
    )
    child_id_by_name = {member["name"]: member["roster_child_id"] for member in members}

    def create(name, child_ids):
        response = client.post(
            f"/api/organization/classrooms/{classroom_id}/projects",
            json={
                "name": name,
                "template_id": template_id,
                "work_slot_id": work_slot_id,
                "owner_id": lead_teacher_id,
                "roster_child_ids": child_ids,
            },
        )
        assert_status(response, 201)
        return response.json()

    source = create(
        unique_name("source_album"),
        [child_id_by_name[name] for name in student_names[:-1]],
    )
    target = create(
        unique_name("target_album"), [child_id_by_name[student_names[-1]]]
    )
    return {
        "template_id": template_id,
        "classroom_id": classroom_id,
        "lead_teacher_id": lead_teacher_id,
        "work_slot_id": work_slot_id,
        "source": source,
        "target": target,
    }


def _student_by_name(project_payload, name):
    return next(
        student for student in project_payload["students"] if student["name"] == name
    )


def test_transfer_moves_student_photo_and_personal_text(tmp_path, monkeypatch):
    """搬過去之後，照片檔案與個人文字都要在新相本，不用重做。"""
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        names = [unique_name("mv_a"), unique_name("mv_b"), unique_name("mv_c")]
        setup = _setup_two_albums(client, names)
        source_id = setup["source"]["id"]
        target_id = setup["target"]["id"]
        moving = _student_by_name(setup["source"], names[0])

        upload = client.post(
            revisioned_project_url(
                client,
                source_id,
                f"/api/projects/{source_id}/students/{moving['id']}/pages/0/photos/1",
            ),
            files={"file": ("moving.jpg", jpeg_bytes(), "image/jpeg")},
        )
        assert_status(upload, 200)

        # 個人文字：直接寫入該生頁面的 label_texts
        texts = client.put(
            revisioned_project_url(
                client, source_id, f"/api/projects/{source_id}/batch/texts"
            ),
            json={"students": {str(moving["id"]): {"0": {"1": "這是我的個人文字"}}}},
        )
        assert_status(texts, 200)

        detail_before = client.get(f"/api/projects/{source_id}").json()
        old_photo_key = (
            _student_by_name(detail_before, names[0])["pages_data"][0]["photos"]["1"]["path"]
        )
        assert f"proj{source_id}" in old_photo_key
        assert (tmp_path / "uploads" / old_photo_key).exists()

        response = client.post(
            f"/api/projects/{source_id}/students/transfer",
            json={"target_project_id": target_id, "student_ids": [moving["id"]]},
        )
        assert_status(response, 200)
        assert response.json()["moved_photo_count"] == 1

        # 學生已不在來源、出現在目標
        source_after = client.get(f"/api/projects/{source_id}").json()
        target_after = client.get(f"/api/projects/{target_id}").json()
        assert names[0] not in [item["name"] for item in source_after["students"]]
        moved = _student_by_name(target_after, names[0])

        # 照片實體搬到新命名空間，個人文字跟著過來
        new_photo_key = moved["pages_data"][0]["photos"]["1"]["path"]
        assert f"proj{target_id}" in new_photo_key
        assert (tmp_path / "uploads" / new_photo_key).exists()
        assert not (tmp_path / "uploads" / old_photo_key).exists()
        assert moved["pages_data"][0]["label_texts"]["1"] == "這是我的個人文字"


def test_transfer_rejects_other_work_slot_and_template(tmp_path, monkeypatch):
    """跨班級期別或跨模板都不准搬：版面與期別歸屬會對不上。"""
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        names = [unique_name("slot_a"), unique_name("slot_b")]
        first = _setup_two_albums(client, names)
        other = _setup_two_albums(
            client, [unique_name("other_a"), unique_name("other_b")]
        )
        moving = _student_by_name(first["source"], names[0])

        response = client.post(
            f"/api/projects/{first['source']['id']}/students/transfer",
            json={
                "target_project_id": other["target"]["id"],
                "student_ids": [moving["id"]],
            },
        )
        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "different_work_slot"


def test_transfer_rejects_emptying_source_album(tmp_path, monkeypatch):
    """把整本搬空應該用刪除相本，不是搬移。"""
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        names = [unique_name("empty_a"), unique_name("empty_b")]
        setup = _setup_two_albums(client, names)
        source = setup["source"]
        response = client.post(
            f"/api/projects/{source['id']}/students/transfer",
            json={
                "target_project_id": setup["target"]["id"],
                "student_ids": [student["id"] for student in source["students"]],
            },
        )
        assert_status(response, 422)
        assert response.json()["detail"]["code"] == "source_would_be_empty"


def test_transfer_rejects_completed_album(tmp_path, monkeypatch):
    """已完成的相本要先退回才能搬，否則等於偷改已確認的內容。"""
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        names = [unique_name("done_a"), unique_name("done_b")]
        setup = _setup_two_albums(client, names)
        target_id = setup["target"]["id"]

        db = SessionLocal()
        try:
            from database import Project, utc_now
            project = db.get(Project, target_id)
            project.completed_at = utc_now()
            db.commit()
        finally:
            db.close()

        moving = _student_by_name(setup["source"], names[0])
        response = client.post(
            f"/api/projects/{setup['source']['id']}/students/transfer",
            json={"target_project_id": target_id, "student_ids": [moving["id"]]},
        )
        assert_status(response, 409)
        assert response.json()["detail"]["code"] == "project_completed"


def test_identity_freeze_still_blocks_cross_slot_move(tmp_path, monkeypatch):
    """窄口之外的 project_id 變更仍由 DB trigger 擋死。"""
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        first = _setup_two_albums(client, [unique_name("frz_a"), unique_name("frz_b")])
        other = _setup_two_albums(client, [unique_name("frz_c"), unique_name("frz_d")])

        db = SessionLocal()
        try:
            student = (
                db.query(ProjectStudent)
                .filter(ProjectStudent.project_id == first["source"]["id"])
                .first()
            )
            student.project_id = other["source"]["id"]
            raised = ""
            try:
                db.commit()
            except Exception as error:  # noqa: BLE001 - 驗證 trigger 訊息
                raised = str(error)
                db.rollback()
            assert "class-backed student identity is immutable" in raised
        finally:
            db.close()


def test_transferred_student_keeps_skip_settings(tmp_path, monkeypatch):
    """跳過的頁面設定存在同一份頁面資料裡，也要跟著走。"""
    use_tmp_uploads(monkeypatch, tmp_path)
    with started_client() as client:
        login(client)
        names = [unique_name("skip_a"), unique_name("skip_b"), unique_name("skip_c")]
        setup = _setup_two_albums(client, names)
        source_id = setup["source"]["id"]
        moving = _student_by_name(setup["source"], names[0])

        skip = client.patch(
            revisioned_project_url(
                client,
                source_id,
                f"/api/projects/{source_id}/students/{moving['id']}/pages/0/skip",
            ),
            json={"skip": True},
        )
        assert_status(skip, 200)

        response = client.post(
            f"/api/projects/{source_id}/students/transfer",
            json={
                "target_project_id": setup["target"]["id"],
                "student_ids": [moving["id"]],
            },
        )
        assert_status(response, 200)

        db = SessionLocal()
        try:
            moved = db.get(ProjectStudent, moving["id"])
            assert moved.project_id == setup["target"]["id"]
            pages = json.loads(moved.pages_data_json)
            assert pages[0].get("skip") is True
        finally:
            db.close()
