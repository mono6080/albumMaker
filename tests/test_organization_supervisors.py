"""分校／部門主管 scope 的完整替換與稽核區間契約。"""

from tests.helpers import (
    assert_status,
    create_user,
    login,
    started_client,
    unique_name,
)


def _create_campus(client, *, is_active: bool = True) -> dict:
    response = client.post(
        "/api/organization/campuses",
        json={"name": unique_name("supervisor_campus"), "is_active": is_active},
    )
    assert_status(response, 201)
    return response.json()


def _scope_payload(
    *,
    campus: list[int] | None = None,
    infant: list[int] | None = None,
    academy: list[int] | None = None,
) -> dict:
    return {
        "campus_supervisor_ids": campus or [],
        "department_supervisors": [
            {"department": "infant", "supervisor_ids": infant or []},
            {"department": "academy", "supervisor_ids": academy or []},
        ],
    }


def _replace_scopes(client, campus_id: int, payload: dict):
    return client.put(
        f"/api/organization/campuses/{campus_id}/supervisors",
        json=payload,
    )


def test_campus_supervisor_replace_preserves_unchanged_rows_and_overview_history():
    with started_client() as client:
        admin = login(client)
        first_supervisor, _ = create_user(client, "supervisor")
        second_supervisor, _ = create_user(client, "supervisor")
        art_user, _ = create_user(client, "art_team")
        campus = _create_campus(client)
        initial_payload = _scope_payload(
            campus=[first_supervisor["id"]],
            infant=[first_supervisor["id"], second_supervisor["id"]],
            academy=[second_supervisor["id"]],
        )

        initial_response = _replace_scopes(client, campus["id"], initial_payload)
        assert_status(initial_response, 200)
        initial_scopes = initial_response.json()["supervisor_scopes"]
        assert initial_scopes["history"] == []
        assert {
            (row["department"], row["supervisor_id"])
            for row in initial_scopes["current"]
        } == {
            (None, first_supervisor["id"]),
            ("infant", first_supervisor["id"]),
            ("infant", second_supervisor["id"]),
            ("academy", second_supervisor["id"]),
        }
        assert all(row["started_by_id"] == admin["id"] for row in initial_scopes["current"])
        assert all(row["started_by_name"] == admin["display_name"] for row in initial_scopes["current"])
        initial_identity = {
            (row["department"], row["supervisor_id"]): (
                row["id"],
                row["started_at"],
            )
            for row in initial_scopes["current"]
        }

        unchanged_response = _replace_scopes(client, campus["id"], initial_payload)
        assert_status(unchanged_response, 200)
        unchanged_scopes = unchanged_response.json()["supervisor_scopes"]
        assert unchanged_scopes["history"] == []
        assert {
            (row["department"], row["supervisor_id"]): (
                row["id"],
                row["started_at"],
            )
            for row in unchanged_scopes["current"]
        } == initial_identity

        replacement_payload = _scope_payload(
            campus=[second_supervisor["id"]],
            infant=[first_supervisor["id"]],
        )
        replacement_response = _replace_scopes(
            client,
            campus["id"],
            replacement_payload,
        )
        assert_status(replacement_response, 200)
        replacement_scopes = replacement_response.json()["supervisor_scopes"]
        current_by_scope = {
            (row["department"], row["supervisor_id"]): row
            for row in replacement_scopes["current"]
        }
        assert set(current_by_scope) == {
            (None, second_supervisor["id"]),
            ("infant", first_supervisor["id"]),
        }
        preserved_infant = current_by_scope[("infant", first_supervisor["id"])]
        assert (
            preserved_infant["id"],
            preserved_infant["started_at"],
        ) == initial_identity[("infant", first_supervisor["id"])]
        history = replacement_scopes["history"]
        assert {
            (row["department"], row["supervisor_id"])
            for row in history
        } == {
            (None, first_supervisor["id"]),
            ("infant", second_supervisor["id"]),
            ("academy", second_supervisor["id"]),
        }
        assert [row["id"] for row in history] == sorted(
            (row["id"] for row in history),
            reverse=True,
        )
        assert {row["ended_at"] for row in history} == {history[0]["ended_at"]}
        assert all(row["end_reason"] == "assignment_replaced" for row in history)
        assert all(row["ended_by_id"] == admin["id"] for row in history)
        assert all(row["ended_by_name"] == admin["display_name"] for row in history)

        overview_response = client.get("/api/organization/overview")
        assert_status(overview_response, 200)
        overview = overview_response.json()
        option_ids = {option["id"] for option in overview["supervisor_options"]}
        assert {first_supervisor["id"], second_supervisor["id"]} <= option_ids
        assert art_user["id"] not in option_ids
        campus_overview = next(
            row for row in overview["campuses"] if row["id"] == campus["id"]
        )
        assert campus_overview["supervisor_scopes"] == replacement_scopes


def test_teacher_and_supervisor_roles_are_candidates_for_both_assignments():
    with started_client() as client:
        login(client)
        teacher, _ = create_user(client, "teacher")
        supervisor, _ = create_user(client, "supervisor")
        art_user, _ = create_user(client, "art_team")
        campus = _create_campus(client)
        classroom_response = client.post(
            "/api/organization/classrooms",
            json={
                "campus_id": campus["id"],
                "department": "infant",
                "name": unique_name("dual_role_classroom"),
            },
        )
        assert_status(classroom_response, 201)
        classroom_id = classroom_response.json()["id"]

        overview_response = client.get("/api/organization/overview")
        assert_status(overview_response, 200)
        overview = overview_response.json()
        teacher_options = {
            option["id"]: option for option in overview["teacher_options"]
        }
        supervisor_options = {
            option["id"]: option for option in overview["supervisor_options"]
        }
        for user in (teacher, supervisor):
            assert teacher_options[user["id"]]["role"] == user["role"]
            assert supervisor_options[user["id"]]["role"] == user["role"]
        assert art_user["id"] not in teacher_options
        assert art_user["id"] not in supervisor_options

        supervisor_assignment = _replace_scopes(
            client,
            campus["id"],
            _scope_payload(campus=[teacher["id"]]),
        )
        assert_status(supervisor_assignment, 200)
        teacher_assignment = client.put(
            f"/api/organization/classrooms/{classroom_id}/teachers",
            json={
                "teachers": [
                    {"teacher_id": supervisor["id"], "duty": "lead"},
                ],
            },
        )
        assert_status(teacher_assignment, 200)

        users_response = client.get("/api/users/")
        assert_status(users_response, 200)
        role_by_id = {
            user["id"]: user["role"] for user in users_response.json()
        }
        assert role_by_id[teacher["id"]] == "teacher"
        assert role_by_id[supervisor["id"]] == "supervisor"

        teacher_demotion = client.patch(
            f"/api/users/{teacher['id']}",
            json={"role": "art_team"},
        )
        assert_status(teacher_demotion, 409)
        assert teacher_demotion.json()["detail"] == "請先解除目前園所主管範圍"
        supervisor_demotion = client.patch(
            f"/api/users/{supervisor['id']}",
            json={"role": "art_team"},
        )
        assert_status(supervisor_demotion, 409)
        assert supervisor_demotion.json()["detail"] == "請先解除目前班級編制"


def test_campus_supervisor_replace_rejects_invalid_payloads_and_non_admin():
    with started_client() as client:
        login(client)
        supervisor, supervisor_password = create_user(client, "supervisor")
        art_user, _ = create_user(client, "art_team")
        campus = _create_campus(client)

        invalid_payloads = [
            _scope_payload(campus=[supervisor["id"], supervisor["id"]]),
            {
                "campus_supervisor_ids": [],
                "department_supervisors": [
                    {"department": "infant", "supervisor_ids": []},
                    {"department": "infant", "supervisor_ids": []},
                ],
            },
            {
                "campus_supervisor_ids": [],
                "department_supervisors": [
                    {"department": "infant", "supervisor_ids": []},
                ],
            },
            {
                "campus_supervisor_ids": [],
                "department_supervisors": [
                    {"department": "infant", "supervisor_ids": []},
                    {"department": "other", "supervisor_ids": []},
                ],
            },
            _scope_payload(campus=[art_user["id"]]),
            _scope_payload(campus=[99999999]),
        ]
        for payload in invalid_payloads:
            response = _replace_scopes(client, campus["id"], payload)
            assert_status(response, 422)

        overview_response = client.get("/api/organization/overview")
        assert_status(overview_response, 200)
        campus_overview = next(
            row
            for row in overview_response.json()["campuses"]
            if row["id"] == campus["id"]
        )
        assert campus_overview["supervisor_scopes"] == {
            "current": [],
            "history": [],
        }

        login(client, supervisor["username"], supervisor_password)
        forbidden_response = _replace_scopes(
            client,
            campus["id"],
            _scope_payload(campus=[supervisor["id"]]),
        )
        assert_status(forbidden_response, 403)


def test_inactive_campus_supervisors_can_only_be_cleared():
    with started_client() as client:
        login(client)
        supervisor, _ = create_user(client, "supervisor")
        campus = _create_campus(client)
        assigned_response = _replace_scopes(
            client,
            campus["id"],
            _scope_payload(campus=[supervisor["id"]]),
        )
        assert_status(assigned_response, 200)

        inactive_response = client.patch(
            f"/api/organization/campuses/{campus['id']}",
            json={"is_active": False},
        )
        assert_status(inactive_response, 200)

        retained_response = _replace_scopes(
            client,
            campus["id"],
            _scope_payload(campus=[supervisor["id"]]),
        )
        assert_status(retained_response, 409)
        assert retained_response.json()["detail"]["code"] == (
            "inactive_campus_supervisors_must_be_empty"
        )

        cleared_response = _replace_scopes(
            client,
            campus["id"],
            _scope_payload(),
        )
        assert_status(cleared_response, 200)
        scopes = cleared_response.json()["supervisor_scopes"]
        assert scopes["current"] == []
        assert len(scopes["history"]) == 1
        assert scopes["history"][0]["supervisor_name"] == supervisor["display_name"]
