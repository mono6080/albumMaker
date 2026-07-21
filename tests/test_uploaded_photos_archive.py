# 上傳照片 ZIP 下載測試
# 覆蓋:photos/archive(全班)與 students/{sid}/photos/archive(單生)——
# 不套完成閘門、ZIP 結構(每生資料夾/共用照片每生一份)、無照片 404、權限矩陣。

import re
from io import BytesIO
from zipfile import ZipFile

from fastapi.testclient import TestClient

from tests.helpers import (
    assert_status,
    create_template_with_page,
    create_user,
    jpeg_bytes,
    login,
    revisioned_project_url,
    started_client,
    unique_name,
    use_tmp_uploads,
)


def _create_active_period(client: TestClient) -> dict:
    response = client.post(
        "/api/templates/periods",
        data={"name": unique_name("period"), "department": "infant", "status": "active"},
    )
    assert_status(response, 200)
    return response.json()


def _create_classroom(client: TestClient) -> int:
    campus_response = client.post(
        "/api/organization/campuses",
        json={"name": unique_name("photo_campus")},
    )
    assert_status(campus_response, 201)
    classroom_response = client.post(
        "/api/organization/classrooms",
        json={
            "campus_id": campus_response.json()["id"],
            "department": "infant",
            "name": unique_name("photo_classroom"),
        },
    )
    assert_status(classroom_response, 201)
    return classroom_response.json()["id"]


def _set_classroom_teachers(
    client: TestClient,
    classroom_id: int,
    teacher_ids: list[int],
) -> None:
    response = client.put(
        f"/api/organization/classrooms/{classroom_id}/teachers",
        json={
            "teachers": [
                {
                    "teacher_id": teacher_id,
                    "duty": "lead" if index == 0 else "co_teacher",
                }
                for index, teacher_id in enumerate(teacher_ids)
            ]
        },
    )
    assert_status(response, 200)


def _add_classroom_members(
    client: TestClient,
    classroom_id: int,
    names: list[str],
) -> None:
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/members/batch",
        json={"members": [{"name": name} for name in names]},
    )
    assert_status(response, 201)


def _create_classroom_project(
    client: TestClient,
    classroom_id: int,
    template_id: int,
) -> int:
    overview = client.get("/api/organization/overview")
    assert_status(overview, 200)
    work_slot_id = next(
        slot["id"]
        for slot in overview.json()["work_slots"]
        if slot["classroom_id"] == classroom_id
        and template_id in slot["template_ids"]
        and slot["can_create_project"]
    )
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/projects",
        json={
            "name": unique_name("photo_project"),
            "template_id": template_id,
            "work_slot_id": work_slot_id,
        },
    )
    assert_status(response, 201)
    return response.json()["id"]


def _project_students(client: TestClient, project_id: int) -> list[dict]:
    detail = client.get(f"/api/projects/{project_id}")
    assert_status(detail, 200)
    return detail.json()["students"]


# 單頁模板 page_index=0 → ZIP entry 頁碼為 p1;檔名尾段為近似原檔名
_ENTRY_BASENAME_PATTERN = re.compile(r"^p1_格[12]_.+\.jpg$")


def test_uploaded_photos_archive_contracts(monkeypatch, tmp_path):
    use_tmp_uploads(monkeypatch, tmp_path)

    with started_client() as client:
        login(client)
        lead_teacher, lead_password = create_user(client, "teacher")
        co_teacher, co_password = create_user(client, "teacher")
        outsider_teacher, outsider_password = create_user(client, "teacher")
        period = _create_active_period(client)
        template_id, _ = create_template_with_page(
            client, photo_slot_count=2, period_id=period["id"]
        )
        classroom_id = _create_classroom(client)
        _set_classroom_teachers(
            client, classroom_id, [lead_teacher["id"], co_teacher["id"]]
        )
        name_a = unique_name("照片甲")
        name_b = unique_name("照片乙")
        _add_classroom_members(client, classroom_id, [name_a, name_b])
        project_id = _create_classroom_project(client, classroom_id, template_id)

        client.cookies.clear()
        login(client, lead_teacher["username"], lead_password)
        students = _project_students(client, project_id)
        assert len(students) == 2
        student_a_id = students[0]["id"]
        student_b_id = students[1]["id"]

        class_archive_path = f"/api/projects/{project_id}/photos/archive"
        student_a_archive_path = (
            f"/api/projects/{project_id}/students/{student_a_id}/photos/archive"
        )

        # 無照片:全班與單生 archive 皆 404
        assert_status(client.get(class_archive_path), 404)
        assert_status(client.get(student_a_archive_path), 404)

        # 個人照片:甲乙各上傳 slot 1;共用照片:slot 2 套用全班
        for student_id, filename, color in (
            (student_a_id, "alpha.jpg", (240, 72, 72)),
            (student_b_id, "beta.jpg", (72, 72, 240)),
        ):
            upload = client.post(
                revisioned_project_url(
                    client,
                    project_id,
                    f"/api/projects/{project_id}/students/{student_id}/pages/0/photos/1",
                ),
                files={"file": (filename, jpeg_bytes(color), "image/jpeg")},
            )
            assert_status(upload, 200)
        shared_upload = client.post(
            revisioned_project_url(
                client,
                project_id,
                f"/api/projects/{project_id}/photos/shared/pages/0/slots/2",
            ),
            files={"file": ("shared.jpg", jpeg_bytes((72, 240, 72)), "image/jpeg")},
        )
        assert_status(shared_upload, 200)
        assert shared_upload.json()["updated"] == 2

        # 不套完成閘門:專案未完成即可下載(對照 download/all* 會 409)
        detail = client.get(f"/api/projects/{project_id}")
        assert_status(detail, 200)
        assert detail.json()["completed_at"] is None
        gated = client.get(f"/api/projects/{project_id}/download/all?mode=screen")
        assert_status(gated, 409)

        class_archive = client.get(class_archive_path)
        assert_status(class_archive, 200)
        assert class_archive.headers["content-type"].startswith("application/zip")
        content_disposition = class_archive.headers["content-disposition"]
        assert content_disposition.startswith("attachment;")
        # RFC 5987:filename* 內含 URL-encoded「上傳照片」
        assert "%E4%B8%8A%E5%82%B3%E7%85%A7%E7%89%87" in content_disposition
        assert class_archive.content.startswith(b"PK")

        with ZipFile(BytesIO(class_archive.content)) as archive:
            entry_names = archive.namelist()
            # 2 生 ×(個人 slot1 + 共用 slot2)= 4;共用照片每生各一份
            assert len(entry_names) == 4
            folders = {name.split("/", 1)[0] for name in entry_names}
            assert len(folders) == 2
            for entry_name in entry_names:
                assert entry_name.count("/") == 1
                basename = entry_name.split("/", 1)[1]
                assert _ENTRY_BASENAME_PATTERN.match(basename), entry_name
                assert archive.read(entry_name).startswith(b"\xff\xd8")
            for folder in folders:
                slot_ids = {
                    name.split("/", 1)[1].split("_")[1]
                    for name in entry_names
                    if name.startswith(f"{folder}/")
                }
                assert slot_ids == {"格1", "格2"}, entry_names

        # 單生 archive:無資料夾層、僅該生的個人 + 共用照片
        student_archive = client.get(student_a_archive_path)
        assert_status(student_archive, 200)
        assert student_archive.headers["content-type"].startswith("application/zip")
        assert student_archive.headers["content-disposition"].startswith("attachment;")
        with ZipFile(BytesIO(student_archive.content)) as archive:
            entry_names = archive.namelist()
            assert len(entry_names) == 2
            for entry_name in entry_names:
                assert "/" not in entry_name
                assert _ENTRY_BASENAME_PATTERN.match(entry_name), entry_name
                assert archive.read(entry_name).startswith(b"\xff\xd8")

        # 權限:同班 co_teacher(can_read、非 owner)200
        client.cookies.clear()
        login(client, co_teacher["username"], co_password)
        assert_status(client.get(class_archive_path), 200)
        assert_status(client.get(student_a_archive_path), 200)

        # 權限:非該班老師(無讀取權)403
        client.cookies.clear()
        login(client, outsider_teacher["username"], outsider_password)
        assert_status(client.get(class_archive_path), 403)
        assert_status(client.get(student_a_archive_path), 403)
