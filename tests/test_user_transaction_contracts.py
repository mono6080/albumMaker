"""User import/delete use cases 的 transaction 粒度與 rollback characterization。"""

from contextlib import contextmanager

import pytest
from sqlalchemy.orm import Session as OrmSession

from database import (
    OrganizationSupervisorAssignment,
    Project,
    ProjectComment,
    SessionLocal,
    User,
)
from services import user_service
from tests.helpers import (
    assert_status,
    create_project_for_owner,
    create_template_with_page,
    create_user,
    login,
    started_client,
    unique_name,
    workbook_bytes,
)


def _mixed_import_rows(supervisor_username: str, teacher_username: str, bad_username: str):
    return [
        ["帳號", "顯示名稱", "密碼", "角色"],
        [supervisor_username, "交易主管", "supervisor-pass", "主管"],
        [teacher_username, "交易老師", "teacher-pass", "老師"],
        ["admin", "既有管理員", "admin-password-123", "管理員"],
        [bad_username, "錯誤角色", "teacher-pass", "不存在角色"],
    ]


def test_mixed_user_import_uses_one_commit(monkeypatch):
    supervisor_username = unique_name("import_tx_supervisor")
    teacher_username = unique_name("import_tx_teacher")
    bad_username = unique_name("import_tx_bad")

    with started_client() as client:
        login(client)
        original_commit = OrmSession.commit
        commit_calls = 0

        def counting_commit(session) -> None:
            nonlocal commit_calls
            commit_calls += 1
            original_commit(session)

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", counting_commit)
            response = client.post(
                "/api/users/import",
                files={
                    "file": (
                        "mixed.xlsx",
                        workbook_bytes(
                            _mixed_import_rows(
                                supervisor_username,
                                teacher_username,
                                bad_username,
                            )
                        ),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    )
                },
            )

        assert_status(response, 201)
        assert commit_calls == 1
        assert response.json()["created_count"] == 2
        assert response.json()["skipped_count"] == 1
        assert response.json()["error_count"] == 1

    db = SessionLocal()
    try:
        supervisor = db.query(User).filter(User.username == supervisor_username).one()
        teacher = db.query(User).filter(User.username == teacher_username).one()
        assert supervisor.role == "supervisor"
        assert teacher.role == "teacher"
        assert db.query(User).filter(User.username == bad_username).first() is None
    finally:
        db.close()


def test_mixed_user_import_commit_failure_rolls_back_all_rows_and_relations(monkeypatch):
    supervisor_username = unique_name("import_fail_supervisor")
    teacher_username = unique_name("import_fail_teacher")
    bad_username = unique_name("import_fail_bad")

    with started_client() as client:
        login(client)
        commit_calls = 0

        def fail_commit(_session) -> None:
            nonlocal commit_calls
            commit_calls += 1
            raise RuntimeError("simulated mixed import commit failure")

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", fail_commit)
            with pytest.raises(RuntimeError, match="mixed import commit failure"):
                client.post(
                    "/api/users/import",
                    files={
                        "file": (
                            "mixed-failure.xlsx",
                            workbook_bytes(
                                _mixed_import_rows(
                                    supervisor_username,
                                    teacher_username,
                                    bad_username,
                                )
                            ),
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        )
                    },
                )

        assert commit_calls == 1

    db = SessionLocal()
    try:
        assert db.query(User).filter(
            User.username.in_([supervisor_username, teacher_username, bad_username])
        ).all() == []
    finally:
        db.close()


def _seed_user_delete_graph(client) -> dict[str, int]:
    supervisor, supervisor_password = create_user(client, "supervisor")
    teacher, _ = create_user(client, "teacher")
    template_id, _ = create_template_with_page(client)

    project_id = create_project_for_owner(
        client,
        template_id,
        teacher["id"],
        name=unique_name("delete_tx_project"),
    )
    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        campus_id = project.classroom.campus_id
    finally:
        db.close()
    supervisor_scope_response = client.put(
        f"/api/organization/campuses/{campus_id}/supervisors",
        json={
            "campus_supervisor_ids": [supervisor["id"]],
            "department_supervisors": [
                {"department": "infant", "supervisor_ids": []},
                {"department": "academy", "supervisor_ids": []},
            ],
        },
    )
    assert_status(supervisor_scope_response, 200)
    db = SessionLocal()
    try:
        supervisor_scope_id = db.query(OrganizationSupervisorAssignment.id).filter(
            OrganizationSupervisorAssignment.supervisor_id == supervisor["id"],
            OrganizationSupervisorAssignment.ended_at.is_(None),
        ).scalar()
        assert supervisor_scope_id is not None
    finally:
        db.close()

    client.cookies.clear()
    login(client, supervisor["username"], supervisor_password)
    comment_response = client.post(
        f"/api/projects/{project_id}/comments",
        data={"content": "刪除交易留言"},
    )
    assert_status(comment_response, 201)

    client.cookies.clear()
    admin_identity = login(client)
    return {
        "admin_id": admin_identity["user_id"],
        "target_user_id": supervisor["id"],
        "project_owner_id": teacher["id"],
        "supervisor_scope_id": supervisor_scope_id,
        "project_id": project_id,
        "comment_id": comment_response.json()["id"],
    }


def test_delete_user_transfers_graph_with_one_commit(monkeypatch):
    with started_client() as client:
        login(client)
        seeded = _seed_user_delete_graph(client)
        original_commit = OrmSession.commit
        original_execute = OrmSession.execute
        real_project_locks = user_service.lock_project_content_writes
        commit_calls = 0
        transaction_events = []

        def counting_commit(session) -> None:
            nonlocal commit_calls
            commit_calls += 1
            transaction_events.append("commit")
            original_commit(session)

        def recording_execute(session, statement, *args, **kwargs):
            if str(statement).strip().upper() == "BEGIN IMMEDIATE":
                transaction_events.append("begin_immediate")
            return original_execute(session, statement, *args, **kwargs)

        @contextmanager
        def recording_project_locks(project_ids):
            transaction_events.append("project_locks_enter")
            with real_project_locks(project_ids):
                yield
            transaction_events.append("project_locks_exit")

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", counting_commit)
            request_patch.setattr(OrmSession, "execute", recording_execute)
            request_patch.setattr(
                user_service,
                "lock_project_content_writes",
                recording_project_locks,
            )
            response = client.delete(f"/api/users/{seeded['target_user_id']}")

        assert_status(response, 200)
        assert commit_calls == 1
        assert transaction_events == [
            "project_locks_enter",
            "begin_immediate",
            "commit",
            "project_locks_exit",
        ]

    db = SessionLocal()
    try:
        assert db.get(User, seeded["target_user_id"]) is None
        project = db.get(Project, seeded["project_id"])
        comment = db.get(ProjectComment, seeded["comment_id"])
        supervisor_scope = db.get(
            OrganizationSupervisorAssignment,
            seeded["supervisor_scope_id"],
        )
        assert project is not None
        assert comment is not None
        assert supervisor_scope is not None
        assert project.owner_id == seeded["project_owner_id"]
        assert comment.author_id == seeded["admin_id"]
        assert supervisor_scope.supervisor_id is None
        assert supervisor_scope.ended_at is not None
        assert supervisor_scope.end_reason == "user_deleted"
    finally:
        db.close()


def test_delete_user_commit_failure_rolls_back_comments_and_organization_scope(
    monkeypatch,
):
    with started_client() as client:
        login(client)
        seeded = _seed_user_delete_graph(client)
        commit_calls = 0

        def fail_commit(_session) -> None:
            nonlocal commit_calls
            commit_calls += 1
            raise RuntimeError("simulated delete user commit failure")

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", fail_commit)
            with pytest.raises(RuntimeError, match="delete user commit failure"):
                client.delete(f"/api/users/{seeded['target_user_id']}")

        assert commit_calls == 1

    db = SessionLocal()
    try:
        assert db.get(User, seeded["target_user_id"]) is not None
        project = db.get(Project, seeded["project_id"])
        comment = db.get(ProjectComment, seeded["comment_id"])
        supervisor_scope = db.get(
            OrganizationSupervisorAssignment,
            seeded["supervisor_scope_id"],
        )
        assert project is not None
        assert comment is not None
        assert supervisor_scope is not None
        assert project.owner_id == seeded["project_owner_id"]
        assert comment.author_id == seeded["target_user_id"]
        assert supervisor_scope.supervisor_id == seeded["target_user_id"]
        assert supervisor_scope.ended_at is None
    finally:
        db.close()
