import copy
import hashlib
import json
import sqlite3

import pytest

import scripts.rerender_production_projects_202607 as rerender_script
from scripts.rerender_production_projects_202607 import (
    ACKNOWLEDGEMENT,
    TARGET_PROJECT_IDS,
    ApiTarget,
    ApiResponse,
    RerenderApplyError,
    RerenderConfigurationError,
    RerenderPreflightError,
    UnixSocketApiClient,
    _validate_acknowledgement,
    _validate_https_base_url,
    build_parser,
    load_target_contract,
    main,
    run_workflow,
)


SYNTHETIC_TARGETS = {
    50: {"name": "測試相本甲", "student_count": 3},
    174: {"name": "測試相本乙", "student_count": 2},
}


def _write_reference_database(database_path, targets=None):
    targets = targets or SYNTHETIC_TARGETS
    with sqlite3.connect(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            );
            CREATE TABLE students (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL
            );
            """
        )
        for project_id, target in targets.items():
            connection.execute(
                "INSERT INTO projects (id, name) VALUES (?, ?)",
                (project_id, target["name"]),
            )
            connection.executemany(
                "INSERT INTO students (id, project_id) VALUES (?, ?)",
                [
                    (project_id * 100 + index, project_id)
                    for index in range(target["student_count"])
                ],
            )


def _load_reviewed_reference(database_path):
    expected_sha256 = hashlib.sha256(database_path.read_bytes()).hexdigest()
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            rerender_script.organization_migration,
            "RELEASE_REFERENCE_DATABASE_SHA256",
            expected_sha256,
        )
        return load_target_contract(database_path)


def _project_payload(project_id, ready_count=0, *, name=None):
    target = SYNTHETIC_TARGETS[project_id]
    return {
        "id": project_id,
        "name": name or target["name"],
        "deleted_at": None,
        "archive_expires_at": None,
        "completed_at": "2026-07-17T12:00:00",
        "permissions": {"can_edit": True},
        "students": [
            {
                "id": project_id * 100 + index,
                "output_filename": (
                    f"projects/proj{project_id}/output/student{index}.pdf"
                    if index < ready_count
                    else None
                ),
            }
            for index in range(target["student_count"])
        ],
    }


class FakeApiClient:
    def __init__(self, projects, *, failing_student_ids=None, malformed_student_ids=None):
        self.projects = copy.deepcopy(projects)
        self.failing_student_ids = set(failing_student_ids or [])
        self.malformed_student_ids = set(malformed_student_ids or [])
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback):
        return None

    def post(self, path, data=None):
        self.calls.append(("POST", path))
        if path == "/api/auth/login":
            assert data and data["password"] == "top-secret"
            return ApiResponse(200, b'{"role":"admin"}')
        path_parts = path.split("/")
        project_id = int(path_parts[3])
        student_id = int(path_parts[5])
        if student_id in self.failing_student_ids:
            return ApiResponse(500, b'{"detail":"render failed"}')
        if student_id in self.malformed_student_ids:
            return ApiResponse(200, b'{"pdf":null,"pages":null,"skipped":false}')
        student = next(
            student
            for student in self.projects[project_id]["students"]
            if student["id"] == student_id
        )
        was_ready = bool(student["output_filename"])
        student["output_filename"] = (
            f"projects/proj{project_id}/output/student{student_id}.pdf"
        )
        payload = {
            "pdf": student["output_filename"],
            "pages": 2,
            "skipped": was_ready,
        }
        return ApiResponse(200, json.dumps(payload).encode("utf-8"))

    def get(self, path):
        self.calls.append(("GET", path))
        project_id = int(path.rsplit("/", 1)[1])
        return ApiResponse(
            200,
            json.dumps(self.projects[project_id], ensure_ascii=False).encode("utf-8"),
        )


def _run(tmp_path, api_client, *, apply_requested, target_contract=None):
    if target_contract is None:
        reference_path = tmp_path / "reviewed-reference.db"
        _write_reference_database(reference_path)
        target_contract = _load_reviewed_reference(reference_path)
    manifest_path = tmp_path / "rerender.manifest.json"
    result = run_workflow(
        api_target=ApiTarget(
            transport="https",
            base_url="https://album.example.test",
        ),
        username="admin",
        password="top-secret",
        password_env_name="ALBUM_MAKER_ADMIN_PASSWORD",
        manifest_path=manifest_path,
        run_id="test-run",
        apply_requested=apply_requested,
        timeout_seconds=30,
        target_contract=target_contract,
        client_factory=lambda **_kwargs: api_client,
    )
    return result, manifest_path


def test_dry_run_logs_in_and_gets_without_render_posts(tmp_path):
    api_client = FakeApiClient(
        {
            50: _project_payload(50),
            174: _project_payload(174),
        }
    )
    result, manifest_path = _run(tmp_path, api_client, apply_requested=False)

    assert result["overall_status"] == "dry_run"
    assert api_client.calls == [
        ("POST", "/api/auth/login"),
        ("GET", "/api/projects/50"),
        ("GET", "/api/projects/174"),
    ]
    assert [project["missing_before"] for project in result["projects"]] == [3, 2]
    assert [project["status"] for project in result["projects"]] == [
        "database_outputs_incomplete",
        "database_outputs_incomplete",
    ]
    manifest_text = manifest_path.read_text(encoding="utf-8")
    assert "top-secret" not in manifest_text
    manifest = json.loads(manifest_text)
    assert manifest["contains_personal_data"] is True
    assert manifest["password_stored"] is False
    assert manifest["api_transport"] == "https"
    assert manifest["reference_database_sha256"] == hashlib.sha256(
        (tmp_path / "reviewed-reference.db").read_bytes()
    ).hexdigest()
    assert manifest["target_projects"] == [
        {
            "project_id": 50,
            "expected_name": "測試相本甲",
            "expected_student_count": 3,
        },
        {
            "project_id": 174,
            "expected_name": "測試相本乙",
            "expected_student_count": 2,
        },
    ]
    assert len(manifest["target_contract_sha256"]) == 64


def test_apply_handles_partial_outputs_and_verifies_reference_counts(tmp_path):
    api_client = FakeApiClient(
        {
            50: _project_payload(50, ready_count=1),
            174: _project_payload(174, ready_count=0),
        }
    )
    result, _manifest_path = _run(tmp_path, api_client, apply_requested=True)

    assert result["overall_status"] == "complete"
    assert [project["status"] for project in result["projects"]] == [
        "complete",
        "complete",
    ]
    assert [project["ready_after"] for project in result["projects"]] == [3, 2]
    student_render_posts = [
        path
        for method, path in api_client.calls
        if method == "POST" and "/students/" in path
    ]
    assert len(student_render_posts) == 5
    assert all(not path.endswith("/render/all") for path in student_render_posts)
    assert api_client.calls.count(("GET", "/api/projects/50")) == 2
    assert api_client.calls.count(("GET", "/api/projects/174")) == 2


def test_apply_verifies_all_projects_even_when_all_output_names_exist(tmp_path):
    api_client = FakeApiClient(
        {
            50: _project_payload(50, ready_count=3),
            174: _project_payload(174, ready_count=2),
        }
    )
    result, _manifest_path = _run(tmp_path, api_client, apply_requested=True)

    assert result["overall_status"] == "complete"
    assert [project["status"] for project in result["projects"]] == [
        "complete",
        "complete",
    ]
    assert len([
        path
        for method, path in api_client.calls
        if method == "POST" and path.startswith("/api/projects/50/students/")
    ]) == 3
    assert len([
        path
        for method, path in api_client.calls
        if method == "POST" and path.startswith("/api/projects/174/students/")
    ]) == 2
    assert api_client.calls.count(("GET", "/api/projects/50")) == 2
    assert api_client.calls.count(("GET", "/api/projects/174")) == 2


def test_wrong_project_name_blocks_every_render(tmp_path):
    api_client = FakeApiClient(
        {
            50: _project_payload(50, name="錯誤專案"),
            174: _project_payload(174),
        }
    )
    manifest_path = tmp_path / "rerender.manifest.json"
    with pytest.raises(RerenderPreflightError, match="名稱不符"):
        _run(tmp_path, api_client, apply_requested=True)

    assert all("/students/" not in path for _method, path in api_client.calls)
    assert ("GET", "/api/projects/50") in api_client.calls
    assert ("GET", "/api/projects/174") in api_client.calls
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["overall_status"] == "preflight_failed"


def test_student_render_error_stops_with_partial_failure_manifest(tmp_path):
    failing_student_id = 50 * 100
    api_client = FakeApiClient(
        {
            50: _project_payload(50),
            174: _project_payload(174),
        },
        failing_student_ids={failing_student_id},
    )
    manifest_path = tmp_path / "rerender.manifest.json"
    with pytest.raises(RerenderApplyError, match="HTTP 500"):
        _run(tmp_path, api_client, apply_requested=True)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["overall_status"] == "partial_failure"
    assert manifest["projects"][0]["status"] == "failed"
    assert all(
        not path.startswith("/api/projects/174/students/")
        for _method, path in api_client.calls
    )


def test_non_null_output_names_do_not_hide_student_render_errors(tmp_path):
    failing_student_id = 50 * 100
    api_client = FakeApiClient(
        {
            50: _project_payload(50, ready_count=3),
            174: _project_payload(174, ready_count=2),
        },
        failing_student_ids={failing_student_id},
    )
    manifest_path = tmp_path / "rerender.manifest.json"

    with pytest.raises(RerenderApplyError, match="HTTP 500"):
        _run(tmp_path, api_client, apply_requested=True)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["overall_status"] == "partial_failure"
    assert manifest["projects"][0]["ready_before"] == 3
    assert manifest["projects"][0]["status"] == "failed"
    assert (
        "POST",
        f"/api/projects/50/students/{failing_student_id}/render",
    ) in api_client.calls
    assert all(
        not path.startswith("/api/projects/174/students/")
        for _method, path in api_client.calls
    )


def test_malformed_student_render_response_stops_and_records_progress(tmp_path):
    malformed_student_id = 50 * 100 + 2
    api_client = FakeApiClient(
        {
            50: _project_payload(50),
            174: _project_payload(174),
        },
        malformed_student_ids={malformed_student_id},
    )
    manifest_path = tmp_path / "rerender.manifest.json"

    with pytest.raises(RerenderApplyError, match="格式錯誤"):
        _run(tmp_path, api_client, apply_requested=True)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["overall_status"] == "partial_failure"
    assert manifest["projects"][0]["rendered_student_ids"] == [5000, 5001]
    assert manifest["projects"][0]["render_response_count"] == 2


def test_reference_database_is_required_and_targets_are_fixed():
    with pytest.raises(SystemExit):
        build_parser().parse_args(
            [
                "--base-url",
                "https://album.example.test",
                "--username",
                "admin",
            ]
        )
    assert TARGET_PROJECT_IDS == (50, 174)


def test_missing_or_wrong_reference_database_is_rejected(tmp_path):
    with pytest.raises(RerenderConfigurationError, match="不存在"):
        load_target_contract(tmp_path / "missing.db")

    wrong_reference_path = tmp_path / "wrong-reference.db"
    _write_reference_database(
        wrong_reference_path,
        {50: SYNTHETIC_TARGETS[50]},
    )
    with pytest.raises(RerenderConfigurationError, match="缺少目標 Project"):
        _load_reviewed_reference(wrong_reference_path)


def test_complete_but_unreviewed_reference_database_is_rejected(tmp_path):
    reference_path = tmp_path / "unreviewed-reference.db"
    _write_reference_database(reference_path)

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            rerender_script.organization_migration,
            "RELEASE_REFERENCE_DATABASE_SHA256",
            "0" * 64,
        )
        with pytest.raises(RerenderConfigurationError, match="凍結 artifact"):
            load_target_contract(reference_path)


@pytest.mark.parametrize("sidecar_suffix", ["-wal", "-shm"])
def test_reference_database_rejects_sidecars(tmp_path, sidecar_suffix):
    reference_path = tmp_path / "reviewed-reference.db"
    _write_reference_database(reference_path)
    reference_path.with_name(reference_path.name + sidecar_suffix).write_bytes(b"x")

    with pytest.raises(RerenderConfigurationError, match="sidecar"):
        load_target_contract(reference_path)


def test_reference_database_uses_read_only_immutable_connection(
    tmp_path,
    monkeypatch,
):
    reference_path = tmp_path / "reviewed-reference.db"
    _write_reference_database(reference_path)
    observed_calls = []
    original_connect = sqlite3.connect

    def recording_connect(database, *args, **kwargs):
        observed_calls.append((database, kwargs.copy()))
        return original_connect(database, *args, **kwargs)

    monkeypatch.setattr(rerender_script.sqlite3, "connect", recording_connect)
    _load_reviewed_reference(reference_path)

    assert len(observed_calls) == 1
    database_uri, options = observed_calls[0]
    assert str(database_uri).endswith("?mode=ro&immutable=1")
    assert options["uri"] is True


def test_reference_drift_blocks_api_and_records_bound_hash(tmp_path):
    reference_path = tmp_path / "reviewed-reference.db"
    _write_reference_database(reference_path)
    target_contract = _load_reviewed_reference(reference_path)
    with sqlite3.connect(reference_path) as connection:
        connection.execute(
            "UPDATE projects SET name = ? WHERE id = ?",
            ("未審核的變更", 50),
        )
    api_client = FakeApiClient(
        {
            50: _project_payload(50),
            174: _project_payload(174),
        }
    )

    with pytest.raises(RerenderPreflightError, match="SHA-256"):
        _run(
            tmp_path,
            api_client,
            apply_requested=False,
            target_contract=target_contract,
        )

    assert api_client.calls == []
    manifest = json.loads(
        (tmp_path / "rerender.manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["overall_status"] == "preflight_failed"
    assert (
        manifest["reference_database_sha256"]
        == target_contract.reference_database_sha256
    )


def test_cli_requires_exact_ack_and_password_env(monkeypatch, tmp_path, capsys):
    with pytest.raises(RerenderConfigurationError):
        _validate_acknowledgement("174,50")
    _validate_acknowledgement(ACKNOWLEDGEMENT)

    monkeypatch.delenv("MISSING_RENDER_PASSWORD", raising=False)
    reference_path = tmp_path / "reviewed-reference.db"
    _write_reference_database(reference_path)
    monkeypatch.setattr(
        rerender_script.organization_migration,
        "RELEASE_REFERENCE_DATABASE_SHA256",
        hashlib.sha256(reference_path.read_bytes()).hexdigest(),
    )
    assert main(
        [
            "--base-url",
            "https://album.example.test",
            "--username",
            "admin",
            "--reference-db",
            str(reference_path),
            "--password-env",
            "MISSING_RENDER_PASSWORD",
            "--manifest",
            str(tmp_path / "manifest.json"),
            "--run-id",
            "missing-password",
        ]
    ) == 2
    output = capsys.readouterr()
    assert "MISSING_RENDER_PASSWORD" in output.err
    assert "top-secret" not in output.err


@pytest.mark.parametrize(
    "base_url",
    [
        "http://album.example.test",
        "https://admin:secret@album.example.test",
        "https://album.example.test/api",
        "https://album.example.test?environment=production",
        "https://album.example.test#production",
        "https://album.example.test:70000",
    ],
)
def test_cli_rejects_non_https_origin_base_url(
    base_url, monkeypatch, tmp_path, capsys
):
    monkeypatch.setenv("RENDER_PASSWORD", "top-secret")
    reference_path = tmp_path / "reviewed-reference.db"
    _write_reference_database(reference_path)
    monkeypatch.setattr(
        rerender_script.organization_migration,
        "RELEASE_REFERENCE_DATABASE_SHA256",
        hashlib.sha256(reference_path.read_bytes()).hexdigest(),
    )

    assert main(
        [
            "--base-url",
            base_url,
            "--username",
            "admin",
            "--reference-db",
            str(reference_path),
            "--password-env",
            "RENDER_PASSWORD",
            "--manifest",
            str(tmp_path / "manifest.json"),
            "--run-id",
            "invalid-base-url",
        ]
    ) == 2

    output = capsys.readouterr()
    assert "base-url" in output.err
    assert "top-secret" not in output.err


def test_https_origin_base_url_is_normalized():
    assert (
        _validate_https_base_url(" https://album.example.test:443/ ")
        == "https://album.example.test:443"
    )


def test_cli_requires_exactly_one_api_transport():
    common_arguments = [
        "--username",
        "admin",
        "--reference-db",
        "reviewed-reference.db",
    ]
    with pytest.raises(SystemExit):
        build_parser().parse_args(common_arguments)
    with pytest.raises(SystemExit):
        build_parser().parse_args(
            [
                "--base-url",
                "https://album.example.test",
                "--unix-socket",
                "/album_maker_socket/app.sock",
                *common_arguments,
            ]
        )


def test_unix_socket_client_sends_form_login_and_reuses_cookie(monkeypatch):
    responses = [
        {
            "status": 200,
            "body": b'{"role":"admin"}',
            "headers": [("Set-Cookie", "session=test-cookie; Path=/; HttpOnly")],
        },
        {"status": 200, "body": b'{"id":50}', "headers": []},
    ]
    requests = []

    class FakeHTTPResponse:
        def __init__(self, response):
            self.status = response["status"]
            self._body = response["body"]
            self._headers = response["headers"]

        def getheaders(self):
            return self._headers

        def read(self):
            return self._body

    class FakeUnixSocketHTTPConnection:
        def __init__(self, **options):
            self.options = options

        def request(self, method, path, body=None, headers=None):
            requests.append((method, path, body, headers, self.options))

        def getresponse(self):
            return FakeHTTPResponse(responses.pop(0))

        def close(self):
            return None

    monkeypatch.setattr(
        rerender_script,
        "UnixSocketHTTPConnection",
        FakeUnixSocketHTTPConnection,
    )
    socket_path = rerender_script.Path("/album_maker_socket/app.sock")
    with UnixSocketApiClient(
        unix_socket_path=socket_path,
        timeout=30,
    ) as client:
        login_response = client.post(
            "/api/auth/login",
            data={"username": "admin", "password": "top-secret"},
        )
        project_response = client.get("/api/projects/50")

    assert login_response.status_code == 200
    assert project_response.status_code == 200
    assert requests[0][0:2] == ("POST", "/api/auth/login")
    assert requests[0][2] == b"username=admin&password=top-secret"
    assert requests[0][3]["Host"] == "localhost"
    assert "Cookie" not in requests[0][3]
    assert requests[1][0:2] == ("GET", "/api/projects/50")
    assert requests[1][3]["Cookie"] == "session=test-cookie"
    assert all(
        request[4]["unix_socket_path"] == socket_path for request in requests
    )


def test_unix_socket_workflow_manifest_only_records_transport_label(tmp_path):
    reference_path = tmp_path / "reviewed-reference.db"
    _write_reference_database(reference_path)
    target_contract = _load_reviewed_reference(reference_path)
    api_client = FakeApiClient(
        {
            50: _project_payload(50),
            174: _project_payload(174),
        }
    )
    socket_path = (tmp_path / "private" / "app.sock").resolve()
    manifest_path = tmp_path / "rerender.manifest.json"

    result = run_workflow(
        api_target=ApiTarget(
            transport="unix-socket",
            unix_socket_path=socket_path,
        ),
        username="admin",
        password="top-secret",
        password_env_name="RENDER_PASSWORD",
        manifest_path=manifest_path,
        run_id="uds-test",
        apply_requested=False,
        timeout_seconds=30,
        target_contract=target_contract,
        client_factory=lambda **_kwargs: api_client,
    )

    manifest_text = manifest_path.read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    assert result["overall_status"] == "dry_run"
    assert manifest["api_transport"] == "unix-socket"
    assert "base_url" not in manifest
    assert str(socket_path) not in manifest_text
    assert "top-secret" not in manifest_text
