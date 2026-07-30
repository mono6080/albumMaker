"""一個班級期別可以有多本相本：同一套排版、不同對應文字。

同格多本的關鍵防線是「同一個孩子只能被其中一本收錄」——重複收錄會讓期末彙整
把同一個孩子算成兩次。
"""

from tests.helpers import (
    _create_classroom_with_lead,
    _find_classroom_work_slot_id,
    assert_status,
    create_template_with_page,
    login,
    started_client,
    unique_name,
)


def _create_active_template(client, department: str = "infant") -> int:
    period_response = client.post(
        "/api/templates/periods",
        data={
            "name": unique_name("multi_album_period"),
            "department": department,
            "status": "active",
        },
    )
    assert_status(period_response, 200)
    template_id, _ = create_template_with_page(
        client,
        period_id=period_response.json()["id"],
    )
    return template_id


def _setup_classroom(client, student_names):
    """建立班級＋主教＋名單，回傳建相本需要的識別與孩子 id。"""
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
    child_id_by_name = {
        member["name"]: member["roster_child_id"]
        for member in members
        if member["status"] == "active"
    }
    return {
        "template_id": template_id,
        "classroom_id": classroom_id,
        "lead_teacher_id": lead_teacher_id,
        "work_slot_id": work_slot_id,
        "child_id_by_name": child_id_by_name,
    }


def _create_album(client, setup, *, name, roster_child_ids=None):
    body = {
        "name": name,
        "template_id": setup["template_id"],
        "work_slot_id": setup["work_slot_id"],
        "owner_id": setup["lead_teacher_id"],
    }
    if roster_child_ids is not None:
        body["roster_child_ids"] = roster_child_ids
    return client.post(
        f"/api/organization/classrooms/{setup['classroom_id']}/projects",
        json=body,
    )


def _student_names(response):
    return sorted(student["name"] for student in response.json()["students"])


def _work_slot(client, work_slot_id):
    overview = client.get("/api/organization/overview")
    assert_status(overview, 200)
    return next(
        slot for slot in overview.json()["work_slots"] if slot["id"] == work_slot_id
    )


def test_same_work_slot_accepts_two_albums_split_by_selected_children():
    """同一格建兩本、各收一部分孩子——這就是「同排版兩套文字」的用法。"""
    with started_client() as client:
        login(client)
        names = [unique_name("multi_a"), unique_name("multi_b"), unique_name("multi_c")]
        setup = _setup_classroom(client, names)
        child_ids = setup["child_id_by_name"]

        first = _create_album(
            client, setup, name=unique_name("album_group_1"),
            roster_child_ids=[child_ids[names[0]]],
        )
        assert_status(first, 201)
        assert _student_names(first) == [names[0]]

        second = _create_album(
            client, setup, name=unique_name("album_group_2"),
            roster_child_ids=[child_ids[names[1]], child_ids[names[2]]],
        )
        assert_status(second, 201)
        assert _student_names(second) == sorted([names[1], names[2]])

        work_slot = _work_slot(client, setup["work_slot_id"])
        assert sorted(work_slot["project_ids"]) == sorted(
            [first.json()["id"], second.json()["id"]]
        )


def test_second_album_without_selection_takes_remaining_children():
    """不指定孩子時，第二本自動接手這格還沒被收錄的孩子。"""
    with started_client() as client:
        login(client)
        names = [unique_name("rest_a"), unique_name("rest_b")]
        setup = _setup_classroom(client, names)

        first = _create_album(
            client, setup, name=unique_name("album_first"),
            roster_child_ids=[setup["child_id_by_name"][names[0]]],
        )
        assert_status(first, 201)

        second = _create_album(client, setup, name=unique_name("album_rest"))
        assert_status(second, 201)
        assert _student_names(second) == [names[1]]


def test_child_cannot_be_collected_by_two_albums_in_same_slot():
    """同一個孩子被同格兩本收錄會讓期末匯出重複，必須擋下。"""
    with started_client() as client:
        login(client)
        names = [unique_name("dup_a"), unique_name("dup_b")]
        setup = _setup_classroom(client, names)
        target_child_id = setup["child_id_by_name"][names[0]]

        assert_status(
            _create_album(
                client, setup, name=unique_name("album_1"),
                roster_child_ids=[target_child_id],
            ),
            201,
        )
        conflict = _create_album(
            client, setup, name=unique_name("album_2"),
            roster_child_ids=[target_child_id],
        )
        assert_status(conflict, 409)
        detail = conflict.json()["detail"]
        assert detail["code"] == "roster_child_already_in_slot"
        assert detail["roster_child_ids"] == [target_child_id]


def test_selecting_child_outside_classroom_roster_is_rejected():
    """只能收這個班目前名單上的孩子。"""
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client, [unique_name("scope_a")])
        other = _setup_classroom(client, [unique_name("scope_b")])
        outsider_child_id = next(iter(other["child_id_by_name"].values()))

        response = _create_album(
            client, setup, name=unique_name("album_outsider"),
            roster_child_ids=[outsider_child_id],
        )
        assert_status(response, 422)
        detail = response.json()["detail"]
        assert detail["code"] == "roster_child_not_in_classroom"
        assert detail["roster_child_ids"] == [outsider_child_id]


def test_slot_with_every_child_assigned_reports_fully_assigned():
    """孩子都編完後，不指定收錄對象就沒東西可建，要明確說明而不是建出空相本。"""
    with started_client() as client:
        login(client)
        setup = _setup_classroom(client, [unique_name("full_a")])

        assert_status(_create_album(client, setup, name=unique_name("album_all")), 201)
        response = _create_album(client, setup, name=unique_name("album_none"))
        assert_status(response, 409)
        assert response.json()["detail"]["code"] == "slot_roster_fully_assigned"


def test_started_at_keeps_first_album_time():
    """started_at 是開工水位，加第二本不該讓進度看起來變晚。"""
    with started_client() as client:
        login(client)
        names = [unique_name("time_a"), unique_name("time_b")]
        setup = _setup_classroom(client, names)

        assert_status(
            _create_album(
                client, setup, name=unique_name("album_early"),
                roster_child_ids=[setup["child_id_by_name"][names[0]]],
            ),
            201,
        )
        first_started_at = _work_slot(client, setup["work_slot_id"])["started_at"]
        assert first_started_at is not None

        assert_status(
            _create_album(
                client, setup, name=unique_name("album_later"),
                roster_child_ids=[setup["child_id_by_name"][names[1]]],
            ),
            201,
        )
        work_slot = _work_slot(client, setup["work_slot_id"])
        assert work_slot["started_at"] == first_started_at
        # 這格仍然可以再建（學期還在進行中），不因為已開工而被鎖住
        assert work_slot["can_create_project"] is True
