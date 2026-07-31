"""班級名單輸入上限與相本學生快照 API 契約。"""

from database import Student, SessionLocal
from services.student_input_policy import (
    PROJECT_STUDENT_MAX_COUNT,
    STUDENT_ALBUM_NAME_MAX_LENGTH,
    STUDENT_BATCH_MAX_SIZE,
    STUDENT_NAME_MAX_LENGTH,
)
from tests.helpers import (
    _create_classroom_with_lead,
    _find_classroom_work_slot_id,
    assert_status,
    create_template_with_page,
    login,
    started_client,
    unique_name,
)


def _add_members(client, classroom_id: int, names: list[str]):
    return client.post(
        f"/api/organization/classrooms/{classroom_id}/members/batch",
        json={"members": [{"name": name} for name in names]},
    )


def _create_snapshot_project(
    client,
    classroom_id: int,
    template_id: int,
    owner_id: int,
) -> dict:
    response = client.post(
        f"/api/organization/classrooms/{classroom_id}/projects",
        json={
            "name": unique_name("snapshot_project"),
            "template_id": template_id,
            "work_slot_id": _find_classroom_work_slot_id(
                client,
                classroom_id,
                template_id,
            ),
            "owner_id": owner_id,
        },
    )
    assert_status(response, 201)
    return response.json()


def _any_roster_child_exists(names: list[str]) -> bool:
    db = SessionLocal()
    try:
        return db.query(Student.id).filter(Student.name.in_(names)).first() is not None
    finally:
        db.close()


def test_classroom_name_is_trimmed_before_project_snapshot_and_overlong_is_rejected():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        classroom_id, owner_id, _ = _create_classroom_with_lead(client, template_id)
        padded_name = "  測試姓名  "
        maximum_name = "名" * STUDENT_NAME_MAX_LENGTH

        accepted = _add_members(client, classroom_id, [padded_name, maximum_name])
        assert_status(accepted, 201)
        assert [member["name"] for member in accepted.json()["created"]] == [
            "測試姓名",
            maximum_name,
        ]

        overlong_name = "名" * (STUDENT_NAME_MAX_LENGTH + 1)
        rejected = _add_members(client, classroom_id, [overlong_name])
        assert_status(rejected, 422)
        assert rejected.json()["detail"][0]["type"] == "string_too_long"
        assert not _any_roster_child_exists([overlong_name])

        project = _create_snapshot_project(client, classroom_id, template_id, owner_id)
        assert {student["name"] for student in project["students"]} == {
            "測試姓名",
            maximum_name,
        }


def test_roster_album_name_limit_rejects_batch_and_patch_without_mutation():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        classroom_id, _, _ = _create_classroom_with_lead(client, template_id)
        maximum_album_name = "稱" * STUDENT_ALBUM_NAME_MAX_LENGTH
        accepted_name = unique_name("accepted_album_name")
        accepted = client.post(
            f"/api/organization/classrooms/{classroom_id}/members/batch",
            json={
                "members": [
                    {"name": accepted_name, "album_name": maximum_album_name}
                ]
            },
        )
        assert_status(accepted, 201)
        member = accepted.json()["created"][0]
        assert member["album_name"] == maximum_album_name

        overlong_album_name = "稱" * (STUDENT_ALBUM_NAME_MAX_LENGTH + 1)
        rejected_name = unique_name("rejected_album_name")
        rejected_batch = client.post(
            f"/api/organization/classrooms/{classroom_id}/members/batch",
            json={
                "members": [
                    {"name": rejected_name, "album_name": overlong_album_name}
                ]
            },
        )
        assert_status(rejected_batch, 422)
        assert not _any_roster_child_exists([rejected_name])

        rejected_patch = client.patch(
            f"/api/organization/classrooms/{classroom_id}/members/{member['id']}",
            json={"album_name": overlong_album_name},
        )
        assert_status(rejected_patch, 422)
        db = SessionLocal()
        try:
            child = db.get(Student, member["roster_child_id"])
            assert child.album_name == maximum_album_name
        finally:
            db.close()


def test_classroom_member_batch_limit_rejects_entire_payload():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        classroom_id, _, _ = _create_classroom_with_lead(client, template_id)
        oversized_names = [
            unique_name(f"oversized_{item_index}")
            for item_index in range(STUDENT_BATCH_MAX_SIZE + 1)
        ]

        response = _add_members(client, classroom_id, oversized_names)

        assert_status(response, 422)
        assert not _any_roster_child_exists(oversized_names)


def test_classroom_capacity_is_the_project_snapshot_capacity():
    with started_client() as client:
        login(client)
        template_id, _ = create_template_with_page(client)
        classroom_id, owner_id, _ = _create_classroom_with_lead(client, template_id)
        name_prefix = unique_name("limit_child")
        names = [
            f"{name_prefix}_{item_index}"
            for item_index in range(PROJECT_STUDENT_MAX_COUNT)
        ]
        assert_status(_add_members(client, classroom_id, names), 201)

        overflow_name = unique_name("limit_overflow")
        overflow = _add_members(client, classroom_id, [overflow_name])
        assert_status(overflow, 422)
        assert overflow.json()["detail"]["code"] == "project_student_limit_exceeded"
        assert not _any_roster_child_exists([overflow_name])

        project = _create_snapshot_project(client, classroom_id, template_id, owner_id)
        assert len(project["students"]) == PROJECT_STUDENT_MAX_COUNT
        assert {student["name"] for student in project["students"]} == set(names)


def test_openapi_exposes_central_roster_album_name_authority():
    with started_client() as client:
        schema = client.get("/openapi.json").json()
        paths = schema["paths"]

    assert "/api/projects/{project_id}/students" not in paths
    assert "/api/projects/{project_id}/students/batch" not in paths
    assert "/api/projects/{project_id}/students/copy" not in paths
    assert "/api/projects/{project_id}/students/{student_id}" not in paths
    album_name_path = paths[
        "/api/projects/{project_id}/students/{student_id}/album-name"
    ]
    assert set(album_name_path) == {"put"}
    roster_member_patch = paths[
        "/api/organization/classrooms/{classroom_id}/members/{member_id}"
    ]["patch"]
    request_schema_ref = roster_member_patch["requestBody"]["content"][
        "application/json"
    ]["schema"]["$ref"]
    request_schema_name = request_schema_ref.rsplit("/", 1)[-1]
    request_properties = schema["components"]["schemas"][request_schema_name][
        "properties"
    ]
    assert "album_name" in request_properties
