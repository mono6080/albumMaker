"""透過正式 API 驗證並補渲染 2026-07 上線前指定相本的 PDF。

預設只登入並 GET 核對 Project 50、174，不呼叫 render API。加上 ``--apply``
與精確 project id acknowledgement 後才逐位呼叫正式單生 render 端點。
專案名稱與學生數只從已審核的私有 reference DB 讀取，不寫死在公開程式碼。
密碼只從指定環境變數讀取，絕不寫入報告或終端輸出。
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import socket
import sqlite3
import sys
from dataclasses import dataclass
from http.cookiejar import CookieJar
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.data_script_utils import (
    generate_run_id,
    run_scoped_path,
    utc_now_iso,
    validate_run_id,
    write_manifest,
)
from scripts import migrate_production_organization_202607 as organization_migration


OPERATION = "rerender_production_projects_202607"
MANIFEST_SCHEMA_VERSION = 2
DEFAULT_PASSWORD_ENV = "ALBUM_MAKER_ADMIN_PASSWORD"
DEFAULT_MANIFEST = ROOT_DIR / "output" / "production-rerender-202607.json"
TARGET_PROJECT_IDS = (50, 174)
ACKNOWLEDGEMENT = "50,174"


@dataclass(frozen=True)
class ProjectTargetContract:
    """reference DB 對單一目標 Project 的審核結果。"""

    project_id: int
    expected_name: str
    expected_student_count: int


@dataclass(frozen=True)
class RerenderTargetContract:
    """與參考檔 SHA-256 綁定的私有目標契約。"""

    reference_database_path: Path
    reference_database_sha256: str
    projects: tuple[ProjectTargetContract, ...]


@dataclass(frozen=True)
class ApiTarget:
    """只允許正式 HTTPS 或容器內 Unix socket 其中一種傳輸。"""

    transport: str
    base_url: str | None = None
    unix_socket_path: Path | None = None


class RerenderConfigurationError(RuntimeError):
    """CLI 或秘密來源不完整，尚未呼叫 API。"""


class RerenderPreflightError(RuntimeError):
    """登入或 Project guard 不符，沒有呼叫 render API。"""


class RerenderApplyError(RuntimeError):
    """至少一個正式 render 或套用後驗證失敗。"""


class ApiTransportError(RuntimeError):
    """正式 API 無法連線。"""


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_reference_single_file(reference_database_path: Path) -> None:
    if not reference_database_path.is_file():
        raise RerenderConfigurationError(
            f"reference DB 不存在或不是檔案：{reference_database_path}"
        )
    for suffix in ("-wal", "-shm"):
        sidecar = reference_database_path.with_name(
            reference_database_path.name + suffix
        )
        if sidecar.exists():
            raise RerenderConfigurationError(
                f"reference DB 不可帶 SQLite sidecar：{sidecar.name}"
            )


def _target_contract_payload(
    target_contract: RerenderTargetContract,
) -> list[dict[str, Any]]:
    return [
        {
            "project_id": target.project_id,
            "expected_name": target.expected_name,
            "expected_student_count": target.expected_student_count,
        }
        for target in target_contract.projects
    ]


def _target_contract_sha256(target_contract: RerenderTargetContract) -> str:
    payload = json.dumps(
        _target_contract_payload(target_contract),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _validate_target_contract(target_contract: RerenderTargetContract) -> None:
    if tuple(target.project_id for target in target_contract.projects) != (
        TARGET_PROJECT_IDS
    ):
        raise RerenderConfigurationError("target contract 的 Project id 不符")
    if any(
        not target.expected_name.strip()
        or target.expected_student_count <= 0
        for target in target_contract.projects
    ):
        raise RerenderConfigurationError("target contract 的專案名稱或學生數不合法")
    reference_sha256 = target_contract.reference_database_sha256.lower()
    if len(reference_sha256) != 64 or any(
        character not in "0123456789abcdef" for character in reference_sha256
    ):
        raise RerenderConfigurationError("target contract 的 reference SHA-256 不合法")


def load_target_contract(reference_database_path: Path) -> RerenderTargetContract:
    """以 read-only immutable SQLite 連線從私有 reference 建立契約。"""
    reference_database_path = reference_database_path.resolve()
    _validate_reference_single_file(reference_database_path)
    sha256_before = _file_sha256(reference_database_path)
    if sha256_before != organization_migration.RELEASE_REFERENCE_DATABASE_SHA256:
        raise RerenderConfigurationError(
            "reference DB 不是本次 release 已凍結 artifact"
        )
    try:
        with sqlite3.connect(
            f"{reference_database_path.as_uri()}?mode=ro&immutable=1",
            uri=True,
        ) as connection:
            connection.execute("PRAGMA query_only=ON")
            integrity_rows = connection.execute("PRAGMA integrity_check").fetchall()
            if integrity_rows != [("ok",)]:
                raise RerenderConfigurationError("reference DB integrity_check 未通過")
            project_rows = connection.execute(
                "SELECT id, name FROM projects "
                "WHERE id IN (?, ?) ORDER BY id",
                TARGET_PROJECT_IDS,
            ).fetchall()
            student_count_rows = connection.execute(
                "SELECT project_id, COUNT(*) FROM students "
                "WHERE project_id IN (?, ?) GROUP BY project_id",
                TARGET_PROJECT_IDS,
            ).fetchall()
    except sqlite3.DatabaseError as error:
        raise RerenderConfigurationError(
            "reference DB 不是可讀取的預期 SQLite schema"
        ) from error

    _validate_reference_single_file(reference_database_path)
    sha256_after = _file_sha256(reference_database_path)
    if sha256_after != sha256_before:
        raise RerenderConfigurationError("reference DB 在讀取期間發生變更")

    project_names = {
        int(project_id): name
        for project_id, name in project_rows
        if isinstance(name, str)
    }
    student_counts = {
        int(project_id): int(student_count)
        for project_id, student_count in student_count_rows
    }
    if set(project_names) != set(TARGET_PROJECT_IDS):
        raise RerenderConfigurationError("reference DB 缺少目標 Project")
    if set(student_counts) != set(TARGET_PROJECT_IDS):
        raise RerenderConfigurationError("reference DB 缺少目標 Project 學生")

    target_contract = RerenderTargetContract(
        reference_database_path=reference_database_path,
        reference_database_sha256=sha256_before,
        projects=tuple(
            ProjectTargetContract(
                project_id=project_id,
                expected_name=project_names[project_id],
                expected_student_count=student_counts[project_id],
            )
            for project_id in TARGET_PROJECT_IDS
        ),
    )
    _validate_target_contract(target_contract)
    return target_contract


def _assert_reference_binding(target_contract: RerenderTargetContract) -> None:
    """每個 API 階段仍必須指向 CLI 建立契約時的同一份檔案。"""
    try:
        _validate_reference_single_file(target_contract.reference_database_path)
        observed_sha256 = _file_sha256(target_contract.reference_database_path)
    except (OSError, RerenderConfigurationError) as error:
        raise RerenderPreflightError(f"reference DB guard 失敗：{error}") from error
    if observed_sha256 != target_contract.reference_database_sha256:
        raise RerenderPreflightError("reference DB SHA-256 與 target contract 不符")


class ApiResponse:
    def __init__(self, status_code: int, body: bytes):
        self.status_code = status_code
        self._body = body

    def json(self) -> Any:
        return json.loads(self._body.decode("utf-8"))


class StdlibApiClient:
    """只使用 Python stdlib 的 Cookie API client，production image 可直接執行。"""

    def __init__(self, *, base_url: str, timeout: float):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))

    def __enter__(self) -> StdlibApiClient:
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback) -> None:
        return None

    def _request(
        self,
        method: str,
        path: str,
        data: dict[str, str] | None = None,
    ) -> ApiResponse:
        encoded_data = urlencode(data).encode("utf-8") if data is not None else None
        headers = (
            {"Content-Type": "application/x-www-form-urlencoded"}
            if encoded_data is not None
            else {}
        )
        request = Request(
            f"{self.base_url}{path}",
            data=encoded_data,
            headers=headers,
            method=method,
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return ApiResponse(int(response.status), response.read())
        except HTTPError as error:
            return ApiResponse(int(error.code), error.read())
        except URLError as error:
            raise ApiTransportError(f"API 無法連線：{self.base_url}") from error

    def get(self, path: str) -> ApiResponse:
        return self._request("GET", path)

    def post(self, path: str, data: dict[str, str] | None = None) -> ApiResponse:
        return self._request("POST", path, data)


class UnixSocketHTTPConnection(http.client.HTTPConnection):
    """把 HTTP/1.1 傳輸限定在單一 Unix domain socket。"""

    def __init__(self, *, unix_socket_path: Path, timeout: float):
        super().__init__(host="localhost", timeout=timeout)
        self.unix_socket_path = unix_socket_path

    def connect(self) -> None:
        unix_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            unix_socket.settimeout(self.timeout)
            unix_socket.connect(str(self.unix_socket_path))
        except BaseException:
            unix_socket.close()
            raise
        self.sock = unix_socket


class UnixSocketApiClient:
    """容器內越過 maintenance nginx 時使用的 Cookie API client。"""

    def __init__(self, *, unix_socket_path: Path, timeout: float):
        self.unix_socket_path = unix_socket_path
        self.timeout = timeout
        self.cookies: dict[str, str] = {}

    def __enter__(self) -> UnixSocketApiClient:
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback) -> None:
        return None

    def _request(
        self,
        method: str,
        path: str,
        data: dict[str, str] | None = None,
    ) -> ApiResponse:
        encoded_data = urlencode(data).encode("utf-8") if data is not None else None
        headers = {"Host": "localhost"}
        if encoded_data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        if self.cookies:
            headers["Cookie"] = "; ".join(
                f"{name}={value}" for name, value in sorted(self.cookies.items())
            )
        connection = UnixSocketHTTPConnection(
            unix_socket_path=self.unix_socket_path,
            timeout=self.timeout,
        )
        try:
            connection.request(method, path, body=encoded_data, headers=headers)
            response = connection.getresponse()
            for header_name, header_value in response.getheaders():
                if header_name.lower() != "set-cookie":
                    continue
                parsed_cookie = SimpleCookie()
                parsed_cookie.load(header_value)
                for name, morsel in parsed_cookie.items():
                    self.cookies[name] = morsel.value
            return ApiResponse(int(response.status), response.read())
        except (OSError, http.client.HTTPException) as error:
            raise ApiTransportError("API Unix socket 無法連線") from error
        finally:
            connection.close()

    def get(self, path: str) -> ApiResponse:
        return self._request("GET", path)

    def post(self, path: str, data: dict[str, str] | None = None) -> ApiResponse:
        return self._request("POST", path, data)


def _request_json(response: ApiResponse, operation: str) -> Any:
    if not 200 <= response.status_code < 300:
        raise RerenderPreflightError(
            f"{operation} 失敗（HTTP {response.status_code}）"
        )
    try:
        return response.json()
    except json.JSONDecodeError as error:
        raise RerenderPreflightError(f"{operation} 回應不是 JSON") from error


def _project_summary(
    target: ProjectTargetContract,
    payload: Any,
) -> dict[str, Any]:
    project_id = target.project_id
    if not isinstance(payload, dict):
        raise RerenderPreflightError(f"Project {project_id} detail 格式錯誤")
    errors: list[str] = []
    if payload.get("id") != project_id:
        errors.append("response id 不符")
    if payload.get("name") != target.expected_name:
        errors.append("名稱不符")
    if payload.get("deleted_at") is not None or payload.get("archive_expires_at") is not None:
        errors.append("不是 active Project")
    permissions = payload.get("permissions")
    if not isinstance(permissions, dict) or permissions.get("can_edit") is not True:
        errors.append("登入帳號沒有 render 所需編輯權")
    students = payload.get("students")
    if (
        not isinstance(students, list)
        or len(students) != target.expected_student_count
    ):
        errors.append(f"學生數不是 {target.expected_student_count}")
        students = []
    student_ids = [student.get("id") for student in students if isinstance(student, dict)]
    if (
        len(student_ids) != len(students)
        or any(not isinstance(student_id, int) for student_id in student_ids)
        or len(set(student_ids)) != len(student_ids)
    ):
        errors.append("Student id 集合格式錯誤或重複")
    invalid_output_ids: list[int] = []
    ready_student_ids: list[int] = []
    missing_student_ids: list[int] = []
    for student in students:
        if not isinstance(student, dict) or not isinstance(student.get("id"), int):
            continue
        output_filename = student.get("output_filename")
        if output_filename is None:
            missing_student_ids.append(student["id"])
        elif isinstance(output_filename, str) and output_filename.strip():
            ready_student_ids.append(student["id"])
        else:
            invalid_output_ids.append(student["id"])
    if invalid_output_ids:
        errors.append(f"output_filename 格式錯誤：{invalid_output_ids}")
    if errors:
        raise RerenderPreflightError(
            f"Project {project_id} preflight 失敗：" + "；".join(errors)
        )
    return {
        "project_id": project_id,
        "expected_name": target.expected_name,
        "expected_student_count": target.expected_student_count,
        "observed_name": payload["name"],
        "student_count": len(students),
        "ready_before": len(ready_student_ids),
        "missing_before": len(missing_student_ids),
        "ready_student_ids_before": ready_student_ids,
        "missing_student_ids_before": missing_student_ids,
        "student_ids": student_ids,
        "observed_completed_at": payload.get("completed_at"),
        "observed_completed_at_after": None,
        # 非空 output_filename 只代表 DB 宣告有輸出，不證明 storage/hash 完整。
        "status": (
            "database_outputs_complete"
            if len(ready_student_ids) == target.expected_student_count
            else "database_outputs_incomplete"
        ),
        "render_response_count": None,
        "rendered_student_ids": [],
        "skipped_count": 0,
        "ready_after": None,
        "missing_after": None,
        "error": None,
    }


def _base_manifest(
    *,
    run_id: str,
    api_target: ApiTarget,
    username: str,
    password_env_name: str,
    apply_requested: bool,
    target_contract: RerenderTargetContract,
) -> dict[str, Any]:
    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "operation": OPERATION,
        "run_id": run_id,
        "mode": "apply" if apply_requested else "dry-run",
        "started_at": utc_now_iso(),
        "finished_at": None,
        "overall_status": "starting",
        "contains_personal_data": True,
        # 只記不含位址或憑證的傳輸類型。
        "api_transport": api_target.transport,
        "username": username,
        "password_env_name": password_env_name,
        "password_stored": False,
        "reference_database_sha256": (
            target_contract.reference_database_sha256
        ),
        "target_contract_sha256": _target_contract_sha256(target_contract),
        "target_projects": _target_contract_payload(target_contract),
        "target_project_ids": list(TARGET_PROJECT_IDS),
        "projects": [],
    }
    if api_target.transport == "https":
        manifest["base_url"] = api_target.base_url
    return manifest


def _login(client: Any, username: str, password: str) -> None:
    response = client.post(
        "/api/auth/login",
        data={"username": username, "password": password},
    )
    payload = _request_json(response, "登入")
    if not isinstance(payload, dict) or payload.get("role") != "admin":
        raise RerenderPreflightError("登入帳號不是 admin")


def _load_project(
    client: Any,
    target: ProjectTargetContract,
) -> dict[str, Any]:
    response = client.get(f"/api/projects/{target.project_id}")
    payload = _request_json(response, f"讀取 Project {target.project_id}")
    return _project_summary(target, payload)


def _load_initial_projects(
    client: Any,
    target_contract: RerenderTargetContract,
) -> list[dict[str, Any]]:
    """先完成兩個 GET，再一起驗 guard；任何錯誤前都不呼叫 render。"""
    payloads: dict[int, Any] = {}
    for target in target_contract.projects:
        response = client.get(f"/api/projects/{target.project_id}")
        payloads[target.project_id] = _request_json(
            response, f"讀取 Project {target.project_id}"
        )
    return [
        _project_summary(target, payloads[target.project_id])
        for target in target_contract.projects
    ]


def _render_student(client: Any, project_id: int, student_id: int) -> bool:
    response = client.post(
        f"/api/projects/{project_id}/students/{student_id}/render"
    )
    if not 200 <= response.status_code < 300:
        raise RerenderApplyError(
            f"Project {project_id} Student {student_id} render 失敗"
            f"（HTTP {response.status_code}）"
        )
    try:
        payload = response.json()
    except json.JSONDecodeError as error:
        raise RerenderApplyError(
            f"Project {project_id} Student {student_id} render 回應不是 JSON"
        ) from error
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("pdf"), str)
        or not payload["pdf"].strip()
        or not isinstance(payload.get("pages"), int)
        or isinstance(payload["pages"], bool)
        or payload["pages"] < 0
        or not isinstance(payload.get("skipped"), bool)
    ):
        raise RerenderApplyError(
            f"Project {project_id} Student {student_id} render 格式錯誤"
        )
    return bool(payload["skipped"])


def run_workflow(
    *,
    api_target: ApiTarget,
    username: str,
    password: str,
    password_env_name: str,
    manifest_path: Path,
    run_id: str,
    apply_requested: bool,
    timeout_seconds: float,
    target_contract: RerenderTargetContract,
    client_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """執行 dry-run 或 reviewed apply，並持續保存可重入狀態。"""
    _validate_target_contract(target_contract)
    _validate_api_target(api_target)
    manifest = _base_manifest(
        run_id=run_id,
        api_target=api_target,
        username=username,
        password_env_name=password_env_name,
        apply_requested=apply_requested,
        target_contract=target_contract,
    )
    write_manifest(manifest_path, manifest)
    try:
        _assert_reference_binding(target_contract)
        selected_client_factory = client_factory or (
            StdlibApiClient
            if api_target.transport == "https"
            else UnixSocketApiClient
        )
        client_arguments: dict[str, Any] = {"timeout": timeout_seconds}
        if api_target.transport == "https":
            client_arguments["base_url"] = api_target.base_url
        else:
            client_arguments["unix_socket_path"] = api_target.unix_socket_path
        with selected_client_factory(**client_arguments) as client:
            _login(client, username, password)
            project_entries = _load_initial_projects(client, target_contract)
            manifest["projects"] = project_entries
            _assert_reference_binding(target_contract)
            if not apply_requested:
                manifest["overall_status"] = "dry_run"
                manifest["finished_at"] = utc_now_iso()
                write_manifest(manifest_path, manifest)
                return manifest

            for project_entry in project_entries:
                project_entry["status"] = "verification_render_required"
            manifest["overall_status"] = "applying"
            write_manifest(manifest_path, manifest)
            for project_entry, target in zip(
                project_entries,
                target_contract.projects,
                strict=True,
            ):
                project_id = int(project_entry["project_id"])
                project_entry["status"] = "rendering"
                write_manifest(manifest_path, manifest)
                try:
                    _assert_reference_binding(target_contract)
                    for student_id in project_entry["student_ids"]:
                        _assert_reference_binding(target_contract)
                        was_skipped = _render_student(
                            client,
                            project_id,
                            int(student_id),
                        )
                        project_entry["rendered_student_ids"].append(student_id)
                        project_entry["skipped_count"] += int(was_skipped)
                        project_entry["render_response_count"] = len(
                            project_entry["rendered_student_ids"]
                        )
                        write_manifest(manifest_path, manifest)
                    after = _load_project(client, target)
                    if after["ready_before"] != target.expected_student_count:
                        raise RerenderApplyError(
                            f"Project {project_id} render 後只有 "
                            f"{after['ready_before']}/"
                            f"{target.expected_student_count} 份 output"
                        )
                    project_entry["observed_completed_at_after"] = after[
                        "observed_completed_at"
                    ]
                    if (
                        after["observed_completed_at"]
                        != project_entry["observed_completed_at"]
                    ):
                        raise RerenderApplyError(
                            f"Project {project_id} render 前後完成狀態漂移"
                        )
                    _assert_reference_binding(target_contract)
                    project_entry["ready_after"] = after["ready_before"]
                    project_entry["missing_after"] = after["missing_before"]
                    project_entry["status"] = "complete"
                    write_manifest(manifest_path, manifest)
                except (
                    ApiTransportError,
                    RerenderApplyError,
                    RerenderPreflightError,
                ) as error:
                    project_entry["status"] = "failed"
                    project_entry["error"] = str(error)
                    manifest["overall_status"] = "partial_failure"
                    manifest["finished_at"] = utc_now_iso()
                    write_manifest(manifest_path, manifest)
                    raise RerenderApplyError(str(error)) from error
    except RerenderApplyError:
        raise
    except (ApiTransportError, RerenderPreflightError) as error:
        manifest["overall_status"] = "preflight_failed"
        manifest["error"] = str(error)
        manifest["finished_at"] = utc_now_iso()
        write_manifest(manifest_path, manifest)
        raise RerenderPreflightError(str(error)) from error

    manifest["overall_status"] = "complete"
    manifest["finished_at"] = utc_now_iso()
    write_manifest(manifest_path, manifest)
    return manifest


def _validate_acknowledgement(value: str | None) -> None:
    if value != ACKNOWLEDGEMENT:
        raise RerenderConfigurationError(
            f"--apply 必須同時指定 --acknowledge-project-ids {ACKNOWLEDGEMENT}"
        )


def _validate_https_base_url(value: str) -> str:
    normalized = value.strip()
    parsed = urlsplit(normalized)
    try:
        parsed_port = parsed.port
    except ValueError as error:
        raise RerenderConfigurationError("--base-url port 格式錯誤") from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
        or parsed_port is not None and not 1 <= parsed_port <= 65535
    ):
        raise RerenderConfigurationError(
            "--base-url 必須是正式 HTTPS origin，不可含帳密、路徑、query 或 fragment"
        )
    return normalized.rstrip("/")


def _validate_unix_socket_path(value: Path) -> Path:
    resolved = value.resolve()
    if not resolved.is_socket():
        raise RerenderConfigurationError(
            "--unix-socket 必須指向已存在的 Unix domain socket"
        )
    return resolved


def _validate_api_target(api_target: ApiTarget) -> None:
    if api_target.transport == "https":
        if api_target.base_url is None or api_target.unix_socket_path is not None:
            raise RerenderConfigurationError("HTTPS API target 格式錯誤")
        if _validate_https_base_url(api_target.base_url) != api_target.base_url:
            raise RerenderConfigurationError("HTTPS API target 尚未正規化")
        return
    if api_target.transport == "unix-socket":
        if api_target.unix_socket_path is None or api_target.base_url is not None:
            raise RerenderConfigurationError("Unix socket API target 格式錯誤")
        if not api_target.unix_socket_path.is_absolute():
            raise RerenderConfigurationError("Unix socket API target 必須是絕對路徑")
        return
    raise RerenderConfigurationError("API transport 只可是 https 或 unix-socket")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    transport_group = parser.add_mutually_exclusive_group(required=True)
    transport_group.add_argument(
        "--base-url",
        help="正式 HTTPS origin，例如 https://album.example.com",
    )
    transport_group.add_argument(
        "--unix-socket",
        type=Path,
        help="maintenance 期間容器內 app Unix domain socket",
    )
    parser.add_argument("--username", required=True)
    parser.add_argument(
        "--reference-db",
        type=Path,
        required=True,
        help="已審核且單檔凍結的私有 reference SQLite DB",
    )
    parser.add_argument("--password-env", default=DEFAULT_PASSWORD_ENV)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--run-id", type=validate_run_id)
    parser.add_argument("--timeout-seconds", type=float, default=3600.0)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--acknowledge-project-ids")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        if args.timeout_seconds <= 0:
            raise RerenderConfigurationError("--timeout-seconds 必須大於 0")
        if args.apply:
            _validate_acknowledgement(args.acknowledge_project_ids)
        elif args.acknowledge_project_ids is not None:
            raise RerenderConfigurationError(
                "--acknowledge-project-ids 只可搭配 --apply"
            )
        password = os.environ.get(args.password_env)
        if not password:
            raise RerenderConfigurationError(
                f"環境變數 {args.password_env} 未設定或為空"
            )
        target_contract = load_target_contract(args.reference_db)
        run_id = args.run_id or generate_run_id()
        manifest_path = run_scoped_path(args.manifest.resolve(), run_id)
        if manifest_path.exists():
            raise RerenderConfigurationError(f"manifest 已存在：{manifest_path}")
        api_target = (
            ApiTarget(
                transport="https",
                base_url=_validate_https_base_url(args.base_url),
            )
            if args.base_url is not None
            else ApiTarget(
                transport="unix-socket",
                unix_socket_path=_validate_unix_socket_path(args.unix_socket),
            )
        )
        result = run_workflow(
            api_target=api_target,
            username=args.username,
            password=password,
            password_env_name=args.password_env,
            manifest_path=manifest_path,
            run_id=run_id,
            apply_requested=args.apply,
            timeout_seconds=args.timeout_seconds,
            target_contract=target_contract,
        )
        print(
            "補渲染完成" if args.apply else "dry-run 完成，未呼叫 render API"
        )
        for project in result["projects"]:
            print(
                f"Project {project['project_id']}："
                f"{project['ready_before']}/"
                f"{project['expected_student_count']} 已有 output；"
                f"狀態 {project['status']}"
            )
        print(f"manifest：{manifest_path}")
        return 0
    except RerenderApplyError as error:
        print(f"補渲染未完整成功：{error}", file=sys.stderr)
        return 1
    except (
        OSError,
        ApiTransportError,
        RerenderConfigurationError,
        RerenderPreflightError,
    ) as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
