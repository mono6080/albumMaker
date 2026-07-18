"""舊相本明確歸班與可選目前名單 seed 的原子遷移契約。"""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session as OrmSession

from database import (
    ClassRosterMember,
    Project,
    RosterChild,
    SessionLocal,
    Student,
    Template,
    User,
)
from tests.helpers import (
    assert_status,
    create_template_with_page,
    create_user,
    login,
    started_client,
    unique_name,
)


def _create_active_template(client, department: str = "infant") -> int:
    period_response = client.post(
        "/api/templates/periods",
        data={
            "name": unique_name("migration_period"),
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


def _create_unassigned_project(
    client,
    template_id: int,
    student_names: list[str],
) -> dict:
    db = SessionLocal()
    try:
        template = db.query(Template).filter(Template.id == template_id).one()
        admin = db.query(User).filter(User.username == "admin").one()
        project = Project(
            name=unique_name("legacy_project"),
            template_id=template.id,
            department=template.period.department,
            template_period_id=template.period_id,
            template_revision=template.revision,
            owner_id=admin.id,
            created_by_id=admin.id,
            created_by_name=admin.display_name,
        )
        db.add(project)
        db.flush()
        for order_index, student_name in enumerate(student_names):
            roster_child = RosterChild(name=student_name)
            db.add(roster_child)
            db.flush()
            db.add(Student(
                project_id=project.id,
                name=student_name,
                order_index=order_index,
                pages_data_json="[]",
                roster_child_id=roster_child.id,
            ))
        db.commit()
        project_id = project.id
    finally:
        db.close()
    detail_response = client.get(f"/api/projects/{project_id}")
    assert_status(detail_response, 200)
    return detail_response.json()


def _create_classroom(client, department: str = "infant") -> tuple[dict, dict]:
    campus_response = client.post(
        "/api/organization/campuses",
        json={"name": unique_name("migration_campus")},
    )
    assert_status(campus_response, 201)
    campus = campus_response.json()
    classroom_response = client.post(
        "/api/organization/classrooms",
        json={
            "campus_id": campus["id"],
            "department": department,
            "name": unique_name("migration_classroom"),
        },
    )
    assert_status(classroom_response, 201)
    return campus, classroom_response.json()


def _assign_project(
    client,
    project_id: int,
    classroom_id: int,
    *,
    seed_current_roster: bool,
    decisions: list[dict] | None = None,
    source_fingerprint: str | None = None,
    confirmed_all: bool = True,
):
    preview = client.get(
        f"/api/organization/projects/{project_id}/classroom-migration-preview",
        params={"classroom_id": classroom_id},
    )
    if preview.status_code != 200:
        return preview
    preview_payload = preview.json()
    if decisions is None:
        decisions = [
            {"student_id": row["student_id"], "action": "create_new"}
            for row in preview_payload["students"]
        ]
    return client.put(
        f"/api/organization/projects/{project_id}/classroom",
        json={
            "classroom_id": classroom_id,
            "source_fingerprint": (
                source_fingerprint or preview_payload["source_fingerprint"]
            ),
            "confirmed_all": confirmed_all,
            "seed_current_roster": seed_current_roster,
            "student_identity_decisions": decisions,
        },
    )


def _project_identity(project: dict) -> dict:
    return {
        "id": project["id"],
        "name": project["name"],
        "template_id": project["template_id"],
        "owner_id": project["owner_id"],
        "students": [
            {
                "id": student["id"],
                "name": student["name"],
                "album_name": student["album_name"],
            }
            for student in project["students"]
        ],
    }


def _project_roster_links(project_id: int):
    db = SessionLocal()
    try:
        return [
            (student.id, student.roster_child_id)
            for student in db.query(Student)
            .filter(Student.project_id == project_id)
            .order_by(Student.id)
            .all()
        ]
    finally:
        db.close()


def _assert_project_unassigned(project_id: int) -> None:
    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id).one()
        assert project.classroom_id is None
        assert project.campus_name_snapshot is None
        assert project.classroom_name_snapshot is None
    finally:
        db.close()


def _migration_ledger_rows(project_id: int) -> tuple[list, list]:
    db = SessionLocal()
    try:
        headers = list(db.execute(text("""
            SELECT id, project_id_snapshot, target_classroom_id_snapshot,
                   student_count, seeded_member_count,
                   applied_by_id_snapshot, applied_by_name_snapshot,
                   source_fingerprint
            FROM legacy_project_classroom_migrations
            WHERE project_id_snapshot = :project_id
        """), {"project_id": project_id}))
        resolutions = list(db.execute(text("""
            SELECT project_id_snapshot, student_id_snapshot,
                   original_roster_child_id_snapshot,
                   resolved_roster_child_id_snapshot,
                   resolution_action, seeded_current_roster,
                   class_roster_member_id_snapshot
            FROM legacy_student_identity_resolutions
            WHERE project_id_snapshot = :project_id
            ORDER BY student_id_snapshot
        """), {"project_id": project_id}))
        return headers, resolutions
    finally:
        db.close()


def test_assign_project_without_seed_only_adds_explicit_organization_metadata():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        project = _create_unassigned_project(
            client,
            template_id,
            ["歸班王小明", "歸班李小華"],
        )
        campus, classroom = _create_classroom(client)
        before_identity = _project_identity(project)
        before_roster_links = _project_roster_links(project["id"])
        overview_before = client.get("/api/organization/overview")
        assert_status(overview_before, 200)
        migration_before = overview_before.json()["migration_status"]
        assert migration_before["unassigned_project_count"] >= 1
        assert any(
            row["id"] == project["id"]
            for row in overview_before.json()["unassigned_projects"]
        )

        response = _assign_project(
            client,
            project["id"],
            classroom["id"],
            seed_current_roster=False,
        )
        assert_status(response, 200)
        result = response.json()
        assert result["seeded_members"] == []
        assert result["project"]["classroom_id"] == classroom["id"]
        assert result["project"]["campus_name"] == campus["name"]
        assert result["project"]["classroom_name"] == classroom["name"]
        assert _project_identity(result["project"]) == before_identity
        after_roster_links = _project_roster_links(project["id"])
        assert after_roster_links != before_roster_links
        assert len({child_id for _, child_id in after_roster_links}) == 2
        assert {
            row["original_roster_child_id"]
            for row in result["identity_resolutions"]
        } == {child_id for _, child_id in before_roster_links}
        assert {
            row["resolved_roster_child_id"]
            for row in result["identity_resolutions"]
        } == {child_id for _, child_id in after_roster_links}
        assert result["migration_status"]["unassigned_project_count"] == (
            migration_before["unassigned_project_count"] - 1
        )
        assert result["migration_status"]["is_complete"] == (
            result["migration_status"]["unassigned_project_count"] == 0
        )

        overview_after = client.get("/api/organization/overview")
        assert_status(overview_after, 200)
        assigned_classroom = next(
            classroom_row
            for campus_row in overview_after.json()["campuses"]
            if campus_row["id"] == campus["id"]
            for classroom_row in campus_row["classrooms"]
            if classroom_row["id"] == classroom["id"]
        )
        assert assigned_classroom["members"] == []
        assert any(
            row["id"] == project["id"] for row in assigned_classroom["projects"]
        )
        assert all(
            row["id"] != project["id"]
            for row in overview_after.json()["unassigned_projects"]
        )
        duplicate_response = _assign_project(
            client,
            project["id"],
            classroom["id"],
            seed_current_roster=False,
        )
        assert_status(duplicate_response, 409)


def test_assign_project_can_seed_empty_current_roster_with_one_timestamp():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        project = _create_unassigned_project(
            client,
            template_id,
            ["種子林小星", "種子陳小陽"],
        )
        before_identity = _project_identity(project)
        before_roster_links = _project_roster_links(project["id"])
        _, classroom = _create_classroom(client)

        response = _assign_project(
            client,
            project["id"],
            classroom["id"],
            seed_current_roster=True,
        )
        assert_status(response, 200)
        result = response.json()
        assert _project_identity(result["project"]) == before_identity
        assert _project_roster_links(project["id"]) != before_roster_links
        assert {member["name"] for member in result["seeded_members"]} == {
            "種子林小星",
            "種子陳小陽",
        }
        assert len({member["started_at"] for member in result["seeded_members"]}) == 1
        assert all(member["status"] == "active" for member in result["seeded_members"])


def test_project_roster_seed_conflicts_leave_project_and_target_unchanged():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)

        nonempty_project = _create_unassigned_project(
            client,
            template_id,
            ["非空目標相本生"],
        )
        _, nonempty_classroom = _create_classroom(client)
        add_response = client.post(
            f"/api/organization/classrooms/{nonempty_classroom['id']}/members/batch",
            json={"members": [{"name": "既有目前生"}]},
        )
        assert_status(add_response, 201)
        nonempty_response = _assign_project(
            client,
            nonempty_project["id"],
            nonempty_classroom["id"],
            seed_current_roster=True,
        )
        assert_status(nonempty_response, 409)
        assert nonempty_response.json()["detail"]["code"] == (
            "target_classroom_roster_not_empty"
        )
        _assert_project_unassigned(nonempty_project["id"])

        active_elsewhere_project = _create_unassigned_project(
            client,
            template_id,
            ["已在他班學生"],
        )
        _, source_classroom = _create_classroom(client)
        _, empty_target_classroom = _create_classroom(client)
        db = SessionLocal()
        try:
            project_student = db.query(Student).filter(
                Student.project_id == active_elsewhere_project["id"]
            ).one()
            active_child_id = project_student.roster_child_id
            db.add(ClassRosterMember(
                classroom_id=source_classroom["id"],
                roster_child_id=active_child_id,
            ))
            db.commit()
        finally:
            db.close()
        conflict_response = _assign_project(
            client,
            active_elsewhere_project["id"],
            empty_target_classroom["id"],
            seed_current_roster=True,
            decisions=[{
                "student_id": active_elsewhere_project["students"][0]["id"],
                "action": "existing",
                "roster_child_id": active_child_id,
            }],
        )
        assert_status(conflict_response, 409)
        assert conflict_response.json()["detail"]["code"] == (
            "project_child_already_active"
        )
        _assert_project_unassigned(active_elsewhere_project["id"])
        db = SessionLocal()
        try:
            assert db.query(ClassRosterMember.id).filter(
                ClassRosterMember.classroom_id == empty_target_classroom["id"],
                ClassRosterMember.ended_at.is_(None),
            ).count() == 0
        finally:
            db.close()

        mismatch_project = _create_unassigned_project(client, template_id, [])
        _, academy_classroom = _create_classroom(client, "academy")
        mismatch_response = _assign_project(
            client,
            mismatch_project["id"],
            academy_classroom["id"],
            seed_current_roster=False,
        )
        assert_status(mismatch_response, 422)
        assert mismatch_response.json()["detail"]["code"] == (
            "project_classroom_department_mismatch"
        )
        _assert_project_unassigned(mismatch_project["id"])


def test_identity_decisions_reject_legacy_payload_provisional_and_over_capacity():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)

        legacy_payload_project = _create_unassigned_project(
            client,
            template_id,
            ["待配對學生"],
        )
        _, legacy_target = _create_classroom(client)
        legacy_response = client.put(
            f"/api/organization/projects/{legacy_payload_project['id']}/classroom",
            json={
                "classroom_id": legacy_target["id"],
                "seed_current_roster": True,
            },
        )
        assert_status(legacy_response, 422)
        _assert_project_unassigned(legacy_payload_project["id"])

        provisional_project = _create_unassigned_project(
            client,
            template_id,
            ["舊推定身分"],
        )
        _, provisional_target = _create_classroom(client)
        original_child_id = _project_roster_links(provisional_project["id"])[0][1]
        provisional_response = _assign_project(
            client,
            provisional_project["id"],
            provisional_target["id"],
            seed_current_roster=False,
            decisions=[{
                "student_id": provisional_project["students"][0]["id"],
                "action": "existing",
                "roster_child_id": original_child_id,
            }],
        )
        assert_status(provisional_response, 422)
        assert provisional_response.json()["detail"]["code"] == (
            "provisional_identity_not_allowed"
        )
        _assert_project_unassigned(provisional_project["id"])

        oversized_project = _create_unassigned_project(client, template_id, [])
        _, oversized_target = _create_classroom(client)
        db = SessionLocal()
        try:
            for student_index in range(101):
                roster_child = RosterChild(
                    name=unique_name(f"容量學生{student_index}"),
                )
                db.add(roster_child)
                db.flush()
                db.add(Student(
                    project_id=oversized_project["id"],
                    name=roster_child.name,
                    order_index=student_index,
                    pages_data_json="[]",
                    roster_child_id=roster_child.id,
                ))
            db.commit()
        finally:
            db.close()
        oversized_response = _assign_project(
            client,
            oversized_project["id"],
            oversized_target["id"],
            seed_current_roster=True,
        )
        assert_status(oversized_response, 422)
        _assert_project_unassigned(oversized_project["id"])


def test_null_department_migration_uses_explicit_target_and_endpoint_is_admin_only():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        project = _create_unassigned_project(client, template_id, ["跨部門學生"])
        _, academy_classroom = _create_classroom(client, "academy")
        db = SessionLocal()
        try:
            project_record = db.query(Project).filter(
                Project.id == project["id"]
            ).one()
            project_record.department = None
            db.commit()
        finally:
            db.close()

        supervisor, supervisor_password = create_user(client, "supervisor")
        login(client, supervisor["username"], supervisor_password)
        forbidden_response = _assign_project(
            client,
            project["id"],
            academy_classroom["id"],
            seed_current_roster=False,
        )
        assert_status(forbidden_response, 403)
        _assert_project_unassigned(project["id"])

        login(client)
        assigned_response = _assign_project(
            client,
            project["id"],
            academy_classroom["id"],
            seed_current_roster=False,
        )
        assert_status(assigned_response, 200)
        assert assigned_response.json()["project"]["department"] == "academy"


def test_preview_only_offers_established_target_or_same_name_identities():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        project = _create_unassigned_project(
            client,
            template_id,
            ["候選同名學生"],
        )
        original_child_id = _project_roster_links(project["id"])[0][1]
        target_campus, target = _create_classroom(client)
        other_campus, other_classroom = _create_classroom(client)
        target_member = client.post(
            f"/api/organization/classrooms/{target['id']}/members/batch",
            json={"members": [{"name": "目標班不同名"}]},
        )
        assert_status(target_member, 201)
        same_name_member = client.post(
            f"/api/organization/classrooms/{other_classroom['id']}/members/batch",
            json={"members": [{"name": "候選同名學生"}]},
        )
        assert_status(same_name_member, 201)
        target_child_id = target_member.json()["created"][0]["roster_child_id"]
        same_name_child_id = same_name_member.json()["created"][0]["roster_child_id"]
        same_name_member_id = same_name_member.json()["created"][0]["id"]
        historical_project = _create_unassigned_project(
            client,
            template_id,
            ["候選同名學生"],
        )
        historical_assignment = _assign_project(
            client,
            historical_project["id"],
            other_classroom["id"],
            seed_current_roster=False,
            decisions=[{
                "student_id": historical_project["students"][0]["id"],
                "action": "existing",
                "roster_child_id": same_name_child_id,
            }],
        )
        assert_status(historical_assignment, 200)
        ended_membership = client.patch(
            f"/api/organization/classrooms/{other_classroom['id']}"
            f"/members/{same_name_member_id}",
            json={"status": "ended", "end_reason": "departed"},
        )
        assert_status(ended_membership, 200)

        preview = client.get(
            f"/api/organization/projects/{project['id']}/classroom-migration-preview",
            params={"classroom_id": target["id"]},
        )
        assert_status(preview, 200)
        payload = preview.json()
        assert payload["target_classroom"]["seed_allowed"] is False
        student_row = payload["students"][0]
        assert student_row["original_roster_child"] == {
            "id": original_child_id,
            "name": "候選同名學生",
        }
        assert original_child_id not in student_row[
            "allowed_existing_roster_child_ids"
        ]
        assert set(student_row["allowed_existing_roster_child_ids"]) == {
            target_child_id,
            same_name_child_id,
        }
        candidates = {
            row["roster_child_id"]: row
            for row in payload["established_candidates"]
        }
        assert {
            evidence["kind"] for evidence in candidates[target_child_id]["evidence"]
        } >= {"target_membership"}
        target_evidence = next(
            evidence
            for evidence in candidates[target_child_id]["evidence"]
            if evidence["kind"] == "target_membership"
        )
        assert target_evidence == {
            "kind": "target_membership",
            "membership_id": target_member.json()["created"][0]["id"],
            "campus_id": target_campus["id"],
            "campus_name": target_campus["name"],
            "classroom_id": target["id"],
            "classroom_name": target["name"],
            "department": "infant",
            "status": "active",
            "started_at": target_evidence["started_at"],
            "ended_at": None,
            "end_reason": None,
        }
        same_name_evidence = candidates[same_name_child_id]["evidence"]
        assert {evidence["kind"] for evidence in same_name_evidence} >= {
            "same_name_established",
            "same_name_membership",
            "same_name_project",
        }
        membership_evidence = next(
            evidence
            for evidence in same_name_evidence
            if evidence["kind"] == "same_name_membership"
        )
        assert membership_evidence["campus_id"] == other_campus["id"]
        assert membership_evidence["campus_name"] == other_campus["name"]
        assert membership_evidence["classroom_id"] == other_classroom["id"]
        assert membership_evidence["classroom_name"] == other_classroom["name"]
        assert membership_evidence["department"] == "infant"
        assert membership_evidence["status"] == "ended"
        assert membership_evidence["ended_at"] is not None
        project_evidence = next(
            evidence
            for evidence in same_name_evidence
            if evidence["kind"] == "same_name_project"
        )
        assert project_evidence == {
            "kind": "same_name_project",
            "project_id": historical_project["id"],
            "project_name": historical_project["name"],
            "student_id": historical_project["students"][0]["id"],
            "campus_id": other_campus["id"],
            "campus_name": other_campus["name"],
            "classroom_id": other_classroom["id"],
            "classroom_name": other_classroom["name"],
            "department": "infant",
            "period_id": historical_project["template_period_id"],
            "period_name": historical_project["template_period_name"],
            "status": "active",
        }
        repeated_preview = client.get(
            f"/api/organization/projects/{project['id']}"
            "/classroom-migration-preview",
            params={"classroom_id": target["id"]},
        )
        assert_status(repeated_preview, 200)
        assert repeated_preview.json()["source_fingerprint"] == payload[
            "source_fingerprint"
        ]
        assert repeated_preview.json()["students"][0][
            "allowed_existing_roster_child_ids"
        ] == student_row["allowed_existing_roster_child_ids"]


def test_second_historical_project_reuses_first_established_identity_and_ledgers():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        first_project = _create_unassigned_project(
            client,
            template_id,
            ["跨期同一學生"],
        )
        second_project = _create_unassigned_project(
            client,
            template_id,
            ["跨期同一學生"],
        )
        first_original_id = _project_roster_links(first_project["id"])[0][1]
        second_original_id = _project_roster_links(second_project["id"])[0][1]
        assert first_original_id != second_original_id
        _, classroom = _create_classroom(client)

        first_response = _assign_project(
            client,
            first_project["id"],
            classroom["id"],
            seed_current_roster=True,
        )
        assert_status(first_response, 200)
        resolved_child_id = first_response.json()["identity_resolutions"][0][
            "resolved_roster_child_id"
        ]
        assert resolved_child_id not in {first_original_id, second_original_id}

        second_preview = client.get(
            f"/api/organization/projects/{second_project['id']}/classroom-migration-preview",
            params={"classroom_id": classroom["id"]},
        )
        assert_status(second_preview, 200)
        preview_payload = second_preview.json()
        assert preview_payload["target_classroom"]["seed_allowed"] is False
        assert resolved_child_id in preview_payload["students"][0][
            "allowed_existing_roster_child_ids"
        ]
        second_response = client.put(
            f"/api/organization/projects/{second_project['id']}/classroom",
            json={
                "classroom_id": classroom["id"],
                "source_fingerprint": preview_payload["source_fingerprint"],
                "confirmed_all": True,
                "seed_current_roster": False,
                "student_identity_decisions": [{
                    "student_id": second_project["students"][0]["id"],
                    "action": "existing",
                    "roster_child_id": resolved_child_id,
                }],
            },
        )
        assert_status(second_response, 200)
        assert _project_roster_links(second_project["id"])[0][1] == resolved_child_id
        assert second_response.json()["seeded_members"] == []

        first_headers, first_resolutions = _migration_ledger_rows(first_project["id"])
        second_headers, second_resolutions = _migration_ledger_rows(
            second_project["id"]
        )
        assert len(first_headers) == len(second_headers) == 1
        assert first_headers[0][3:5] == (1, 1)
        assert second_headers[0][3:5] == (1, 0)
        assert first_resolutions[0][2:6] == (
            first_original_id,
            resolved_child_id,
            "create_new",
            1,
        )
        assert second_resolutions[0][2:6] == (
            second_original_id,
            resolved_child_id,
            "existing",
            0,
        )
        db = SessionLocal()
        try:
            assert db.query(ClassRosterMember.id).filter(
                ClassRosterMember.classroom_id == classroom["id"],
                ClassRosterMember.ended_at.is_(None),
            ).count() == 1
        finally:
            db.close()


def test_stale_incomplete_and_commit_failure_leave_identity_migration_unwritten(
    monkeypatch,
):
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        project = _create_unassigned_project(
            client,
            template_id,
            ["原子甲生", "原子乙生"],
        )
        before_links = _project_roster_links(project["id"])
        _, classroom = _create_classroom(client)
        preview = client.get(
            f"/api/organization/projects/{project['id']}/classroom-migration-preview",
            params={"classroom_id": classroom["id"]},
        )
        assert_status(preview, 200)
        preview_payload = preview.json()
        full_decisions = [
            {"student_id": row["student_id"], "action": "create_new"}
            for row in preview_payload["students"]
        ]

        incomplete = client.put(
            f"/api/organization/projects/{project['id']}/classroom",
            json={
                "classroom_id": classroom["id"],
                "source_fingerprint": preview_payload["source_fingerprint"],
                "confirmed_all": True,
                "seed_current_roster": False,
                "student_identity_decisions": full_decisions[:1],
            },
        )
        assert_status(incomplete, 422)
        assert incomplete.json()["detail"]["code"] == (
            "identity_decisions_incomplete"
        )
        assert _migration_ledger_rows(project["id"]) == ([], [])
        assert _project_roster_links(project["id"]) == before_links

        renamed = client.patch(
            f"/api/organization/classrooms/{classroom['id']}",
            json={"name": unique_name("stale_target")},
        )
        assert_status(renamed, 200)
        stale = client.put(
            f"/api/organization/projects/{project['id']}/classroom",
            json={
                "classroom_id": classroom["id"],
                "source_fingerprint": preview_payload["source_fingerprint"],
                "confirmed_all": True,
                "seed_current_roster": False,
                "student_identity_decisions": full_decisions,
            },
        )
        assert_status(stale, 409)
        assert stale.json()["detail"]["code"] == (
            "stale_project_classroom_migration_preview"
        )
        assert _migration_ledger_rows(project["id"]) == ([], [])
        assert _project_roster_links(project["id"]) == before_links

        fresh_preview = client.get(
            f"/api/organization/projects/{project['id']}/classroom-migration-preview",
            params={"classroom_id": classroom["id"]},
        ).json()
        db = SessionLocal()
        try:
            child_count_before = db.query(RosterChild.id).count()
            member_count_before = db.query(ClassRosterMember.id).count()
        finally:
            db.close()

        def fail_commit(_session) -> None:
            raise RuntimeError("simulated identity migration commit failure")

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", fail_commit)
            with pytest.raises(
                RuntimeError,
                match="identity migration commit failure",
            ):
                client.put(
                    f"/api/organization/projects/{project['id']}/classroom",
                    json={
                        "classroom_id": classroom["id"],
                        "source_fingerprint": fresh_preview["source_fingerprint"],
                        "confirmed_all": True,
                        "seed_current_roster": True,
                        "student_identity_decisions": full_decisions,
                    },
                )

        _assert_project_unassigned(project["id"])
        assert _project_roster_links(project["id"]) == before_links
        assert _migration_ledger_rows(project["id"]) == ([], [])
        db = SessionLocal()
        try:
            assert db.query(RosterChild.id).count() == child_count_before
            assert db.query(ClassRosterMember.id).count() == member_count_before
        finally:
            db.close()


def test_identity_freeze_transition_guard_rejects_empty_project_and_archive():
    with started_client() as client:
        login(client)
        template_id = _create_active_template(client)
        project = _create_unassigned_project(
            client,
            template_id,
            ["凍結學生"],
        )
        _, classroom = _create_classroom(client)
        response = _assign_project(
            client,
            project["id"],
            classroom["id"],
            seed_current_roster=False,
        )
        assert_status(response, 200)
        student_id = project["students"][0]["id"]
        db = SessionLocal()
        try:
            student = db.get(Student, student_id)
            student.name = "不可改名"
            with pytest.raises(DBAPIError, match="identity is immutable"):
                db.commit()
            db.rollback()
            student = db.get(Student, student_id)
            student.album_name = "可改稱呼"
            db.commit()
            assert db.get(Student, student_id).album_name == "可改稱呼"
        finally:
            db.close()

        zero_student_project = _create_unassigned_project(client, template_id, [])
        _, zero_target = _create_classroom(client)
        zero_response = _assign_project(
            client,
            zero_student_project["id"],
            zero_target["id"],
            seed_current_roster=False,
        )
        assert_status(zero_response, 422)
        assert zero_response.json()["detail"]["code"] == (
            "empty_legacy_project_migration_forbidden"
        )
        _assert_project_unassigned(zero_student_project["id"])
        assert _migration_ledger_rows(zero_student_project["id"]) == ([], [])

        bypass_project = _create_unassigned_project(client, template_id, [])
        bypass_campus, bypass_target = _create_classroom(client)
        db = SessionLocal()
        try:
            admin = db.query(User).filter(User.username == "admin").one()
            db.execute(text("""
                INSERT INTO legacy_project_classroom_migrations (
                    project_id_snapshot, project_name_snapshot,
                    target_campus_id_snapshot, target_campus_name_snapshot,
                    target_classroom_id_snapshot, target_classroom_name_snapshot,
                    target_department_snapshot, source_fingerprint,
                    student_count, seeded_member_count,
                    applied_by_id_snapshot, applied_by_name_snapshot
                ) VALUES (
                    :project_id, :project_name,
                    :campus_id, :campus_name,
                    :classroom_id, :classroom_name,
                    :department, 'forged-empty-ledger',
                    0, 0, :admin_id, :admin_name
                )
            """), {
                "project_id": bypass_project["id"],
                "project_name": bypass_project["name"],
                "campus_id": bypass_target["campus_id"],
                "campus_name": bypass_campus["name"],
                "classroom_id": bypass_target["id"],
                "classroom_name": bypass_target["name"],
                "department": bypass_target["department"],
                "admin_id": admin.id,
                "admin_name": admin.display_name,
            })
            db.commit()
            bypass_record = db.get(Project, bypass_project["id"])
            bypass_record.classroom_id = bypass_target["id"]
            with pytest.raises(DBAPIError, match="empty project cannot enter"):
                db.commit()
            db.rollback()
        finally:
            db.close()
        _assert_project_unassigned(bypass_project["id"])

        archived_project = _create_unassigned_project(client, template_id, [])
        archived = client.delete(f"/api/projects/{archived_project['id']}")
        assert_status(archived, 200)
        archived_preview = client.get(
            f"/api/organization/projects/{archived_project['id']}/classroom-migration-preview",
            params={"classroom_id": bypass_target["id"]},
        )
        assert_status(archived_preview, 409)
        assert archived_preview.json()["detail"]["code"] == (
            "archived_project_migration_forbidden"
        )
        assert _migration_ledger_rows(archived_project["id"]) == ([], [])
