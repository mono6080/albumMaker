# 完成觸發背景渲染與下載前補渲的契約測試
# 觸發點:標記單生完成、手動全班完成、改名清輸出;
# 下載保證:未渲染/輸出被清時,下載端點就地補渲最新內容(不分角色)。

from io import BytesIO
from zipfile import ZipFile

from fastapi.testclient import TestClient

from services import completion_render_service
from services.request_limiter import album_render_limiter
from tests.helpers import (
    assert_status,
    create_project,
    create_template_with_page,
    jpeg_bytes,
    login,
    revisioned_project_url,
    started_client,
    unique_name,
    use_tmp_uploads,
)


def _students_by_name(client: TestClient, project_id: int) -> dict[str, dict]:
    detail = client.get(f"/api/projects/{project_id}")
    assert_status(detail, 200)
    return {student["name"]: student for student in detail.json()["students"]}


def _fill_student_content(client: TestClient, project_id: int, student_id: int) -> None:
    """填滿單生內容(全班文字補文字格、上傳照片),達到標記完成前置條件。"""
    class_fill = client.put(
        revisioned_project_url(
            client, project_id, f"/api/projects/{project_id}/label_texts"
        ),
        json={"0": {"1": "自動渲染全班文字"}},
    )
    assert_status(class_fill, 200)
    photo_fill = client.post(
        revisioned_project_url(
            client,
            project_id,
            f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
        ),
        files={"file": ("fill.jpg", jpeg_bytes(), "image/jpeg")},
    )
    assert_status(photo_fill, 200)


def _record_queue_calls(monkeypatch) -> list[tuple[int, list[int]]]:
    """覆寫 conftest 的 no-op,把 queue 呼叫記錄下來(不真的開執行緒)。"""
    recorded_calls: list[tuple[int, list[int]]] = []
    monkeypatch.setattr(
        completion_render_service,
        "queue_background_student_renders",
        lambda project_id, student_ids: recorded_calls.append(
            (project_id, list(student_ids))
        ),
    )
    return recorded_calls


def test_completion_and_rename_queue_background_renders(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        recorded_calls = _record_queue_calls(monkeypatch)

        template_id, _ = create_template_with_page(client)
        name_a = unique_name("完成甲")
        name_b = unique_name("完成乙")
        project_id = create_project(
            client, template_id, student_names=[name_a, name_b]
        )
        students = _students_by_name(client, project_id)
        student_a = students[name_a]["id"]
        student_b = students[name_b]["id"]

        # 標記單生完成 → 只排該生
        _fill_student_content(client, project_id, student_a)
        complete_a = client.post(
            f"/api/projects/{project_id}/students/{student_a}/complete"
        )
        assert_status(complete_a, 200)
        assert recorded_calls == [(project_id, [student_a])]

        # 冪等重複標記 → 不再排
        complete_a_again = client.post(
            f"/api/projects/{project_id}/students/{student_a}/complete"
        )
        assert_status(complete_a_again, 200)
        assert recorded_calls == [(project_id, [student_a])]

        # 最後一位完成(自動成立全班完成) → 只排該生,其他人早已排過
        _fill_student_content(client, project_id, student_b)
        complete_b = client.post(
            f"/api/projects/{project_id}/students/{student_b}/complete"
        )
        assert_status(complete_b, 200)
        assert complete_b.json()["project_completed_at"] is not None
        assert recorded_calls == [(project_id, [student_a]), (project_id, [student_b])]

        # 改名清輸出 → 有效完成的學生全部重排
        rename = client.patch(
            f"/api/projects/{project_id}",
            data={"name": unique_name("改名後")},
        )
        assert_status(rename, 200)
        assert recorded_calls[-1] == (project_id, [student_a, student_b])


def test_manual_class_completion_queues_all_students(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        recorded_calls = _record_queue_calls(monkeypatch)

        template_id, _ = create_template_with_page(client)
        name_a = unique_name("手動甲")
        name_b = unique_name("手動乙")
        project_id = create_project(
            client, template_id, student_names=[name_a, name_b]
        )
        students = _students_by_name(client, project_id)

        # 手動全班完成(不驗內容) → 全班排入
        complete = client.post(f"/api/projects/{project_id}/complete")
        assert_status(complete, 200)
        assert len(recorded_calls) == 1
        assert recorded_calls[0][0] == project_id
        assert sorted(recorded_calls[0][1]) == sorted(
            [students[name_a]["id"], students[name_b]["id"]]
        )

        # 已完成的重複標記 → 排空清單(no-op 契約)
        complete_again = client.post(f"/api/projects/{project_id}/complete")
        assert_status(complete_again, 200)
        assert recorded_calls[-1] == (project_id, [])


def test_background_render_worker_produces_outputs(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        name_a = unique_name("背景渲染")
        project_id = create_project(client, template_id, student_names=[name_a])
        student_id = _students_by_name(client, project_id)[name_a]["id"]

        assert _students_by_name(client, project_id)[name_a]["output_filename"] is None

        # 同步執行背景 worker 本體(系統渲染、不套編輯 ACL)
        completion_render_service._render_students_in_background(
            project_id, [student_id]
        )

        refreshed = _students_by_name(client, project_id)[name_a]
        assert refreshed["output_filename"] is not None


def test_fresh_download_bypasses_render_slot_queue(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        name_a = unique_name("快路甲")
        project_id = create_project(client, template_id, student_names=[name_a])
        student_id = _students_by_name(client, project_id)[name_a]["id"]

        # 先把輸出渲染到新鮮狀態,再標記完成解鎖下載
        completion_render_service._render_students_in_background(
            project_id, [student_id]
        )
        assert_status(client.post(f"/api/projects/{project_id}/complete"), 200)

        # 模擬背景渲染佔住渲染槽:內容新鮮的下載必須走快路、不得取槽
        def _fail_acquire():
            raise AssertionError("內容新鮮的下載不應取渲染槽")

        monkeypatch.setattr(album_render_limiter, "acquire_blocking", _fail_acquire)
        download = client.get(
            f"/api/projects/{project_id}/students/{student_id}/pdf"
        )
        assert_status(download, 200)
        assert download.content.startswith(b"%PDF")


def test_reconcile_backfills_only_completed_students_and_converges(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        name_a = unique_name("收斂甲")
        name_b = unique_name("進行乙")
        project_id = create_project(
            client, template_id, student_names=[name_a, name_b]
        )
        students = _students_by_name(client, project_id)
        student_a = students[name_a]["id"]

        # 只有 A 標記完成(背景渲染在測試停用,輸出仍空)
        _fill_student_content(client, project_id, student_a)
        assert_status(
            client.post(f"/api/projects/{project_id}/students/{student_a}/complete"),
            200,
        )
        assert _students_by_name(client, project_id)[name_a]["output_filename"] is None

        # 第一輪收斂:補渲 A、不碰未完成的 B
        # (掃描範圍是整個測試 DB,統計含其他測試殘留專案,只驗本專案的結果)
        totals = completion_render_service.reconcile_completed_renders()
        assert totals["rendered"] >= 1
        refreshed = _students_by_name(client, project_id)
        assert refreshed[name_a]["output_filename"] is not None
        assert refreshed[name_b]["output_filename"] is None

        # 第二輪收斂:已補渲者全部指紋 skip,不再重渲
        second_totals = completion_render_service.reconcile_completed_renders()
        assert second_totals["rendered"] == 0


def test_class_zip_download_renders_fresh_without_prior_render(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        name_a = unique_name("補渲甲")
        project_id = create_project(client, template_id, student_names=[name_a])

        # 手動全班完成後(背景渲染在測試停用)直接抓全班 ZIP → 下載端點就地補渲
        complete = client.post(f"/api/projects/{project_id}/complete")
        assert_status(complete, 200)

        download_all = client.get(f"/api/projects/{project_id}/download/all")
        assert_status(download_all, 200)
        assert download_all.content.startswith(b"PK")
        with ZipFile(BytesIO(download_all.content)) as pdf_zip:
            assert any(entry.endswith(".pdf") for entry in pdf_zip.namelist())

        download_all_images = client.get(
            f"/api/projects/{project_id}/download/all/images"
        )
        assert_status(download_all_images, 200)
        assert download_all_images.content.startswith(b"PK")
        with ZipFile(BytesIO(download_all_images.content)) as image_zip:
            assert any(entry.endswith(".jpg") for entry in image_zip.namelist())
