"""User import/delete use cases 的 transaction 粒度與 rollback characterization。"""

import pytest
from sqlalchemy.orm import Session as OrmSession

from database import (
    Project,
    ProjectComment,
    SessionLocal,
    User,
    teacher_supervisors,
)
from tests.helpers import (
    assert_status,
    create_project,
    create_template_with_page,
    create_user,
    login,
    started_client,
    unique_name,
    workbook_bytes,
)


def _teacher_supervisor_ids(db, teacher_id: int) -> list[int]:
    return [
        supervisor_id
        for (supervisor_id,) in (
            db.query(teacher_supervisors.c.supervisor_id)
            .filter(teacher_supervisors.c.teacher_id == teacher_id)
            .order_by(teacher_supervisors.c.supervisor_id)
            .all()
        )
    ]


def _mixed_import_rows(supervisor_username: str, teacher_username: str, bad_username: str):
    return [
        ["帳號", "顯示名稱", "密碼", "角色", "主管帳號"],
        [supervisor_username, "交易主管", "supervisor-pass", "主管", ""],
        [teacher_username, "交易老師", "teacher-pass", "老師", supervisor_username],
        ["admin", "既有管理員", "admin-password-123", "管理員", ""],
        [bad_username, "錯誤老師", "teacher-pass", "老師", "missing-supervisor"],
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
        assert teacher.supervisor_id == supervisor.id
        assert _teacher_supervisor_ids(db, teacher.id) == [supervisor.id]
        assert db.query(User).filter(User.username == bad_username).first() is None
    finally:
        db.close()


def test_mixed_user_import_commit_failure_rolls_back_all_rows_and_relations(monkeypatch):
    supervisor_username = unique_name("import_fail_supervisor")
    teacher_username = unique_name("import_fail_teacher")
    bad_username = unique_name("import_fail_bad")

    with started_client() as client:
        login(client)
        before_db = SessionLocal()
        try:
            relation_count_before = before_db.query(teacher_supervisors).count()
        finally:
            before_db.close()
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
        assert db.query(teacher_supervisors).count() == relation_count_before
        imported_teacher_id = db.query(User.id).filter(User.username == teacher_username).scalar()
        assert imported_teacher_id is None
    finally:
        db.close()


def _seed_user_delete_graph(client) -> dict[str, int]:
    supervisor, supervisor_password = create_user(client, "supervisor")
    teacher, _ = create_user(client, "teacher", supervisor_ids=[supervisor["id"]])
    template_id, _ = create_template_with_page(client)

    client.cookies.clear()
    login(client, supervisor["username"], supervisor_password)
    project_id = create_project(client, template_id, name=unique_name("delete_tx_project"))
    comment_response = client.post(
        f"/api/projects/{project_id}/comments",
        data={"content": "刪除交易留言"},
    )
    assert_status(comment_response, 201)

    client.cookies.clear()
    admin_identity = login(client)
    return {
        "admin_id": admin_identity["user_id"],
        "supervisor_id": supervisor["id"],
        "teacher_id": teacher["id"],
        "project_id": project_id,
        "comment_id": comment_response.json()["id"],
    }


def test_delete_user_transfers_graph_with_one_commit(monkeypatch):
    with started_client() as client:
        login(client)
        seeded = _seed_user_delete_graph(client)
        original_commit = OrmSession.commit
        commit_calls = 0

        def counting_commit(session) -> None:
            nonlocal commit_calls
            commit_calls += 1
            original_commit(session)

        with monkeypatch.context() as request_patch:
            request_patch.setattr(OrmSession, "commit", counting_commit)
            response = client.delete(f"/api/users/{seeded['supervisor_id']}")

        assert_status(response, 200)
        assert commit_calls == 1

    db = SessionLocal()
    try:
        assert db.get(User, seeded["supervisor_id"]) is None
        project = db.get(Project, seeded["project_id"])
        comment = db.get(ProjectComment, seeded["comment_id"])
        assert project is not None
        assert comment is not None
        assert project.owner_id == seeded["admin_id"]
        assert comment.author_id == seeded["admin_id"]
        teacher = db.get(User, seeded["teacher_id"])
        assert teacher is not None
        assert teacher.supervisor_id is None
        assert _teacher_supervisor_ids(db, teacher.id) == []
    finally:
        db.close()


def test_delete_user_commit_failure_rolls_back_owner_comments_and_supervisor_relations(
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
                client.delete(f"/api/users/{seeded['supervisor_id']}")

        assert commit_calls == 1

    db = SessionLocal()
    try:
        assert db.get(User, seeded["supervisor_id"]) is not None
        project = db.get(Project, seeded["project_id"])
        comment = db.get(ProjectComment, seeded["comment_id"])
        assert project is not None
        assert comment is not None
        assert project.owner_id == seeded["supervisor_id"]
        assert comment.author_id == seeded["supervisor_id"]
        teacher = db.get(User, seeded["teacher_id"])
        assert teacher is not None
        assert teacher.supervisor_id == seeded["supervisor_id"]
        assert _teacher_supervisor_ids(db, teacher.id) == [seeded["supervisor_id"]]
    finally:
        db.close()
