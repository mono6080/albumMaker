"""快照、稽核並還原 2026-07 正式切換可能變動的 R2 物件。

快照只寫入 repo 外的私有目錄，不在同一個 R2 bucket 建立副本。operator terminal
不輸出物件 key／姓名，只輸出非 secret binding、counts／bytes／digests／IDs；含舊版
姓名 key 的完整清單只存在私有 manifest。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
for import_root in (ROOT_DIR, BACKEND_DIR):
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))

from scripts.data_script_utils import utc_now_iso, validate_run_id, write_manifest
from services.output_keys import (
    get_project_output_prefix,
    get_student_output_prefix,
    student_output_prefix_from_pdf_key,
    student_pdf_key_for_mode,
)


OPERATION = "snapshot_production_r2_outputs_202607"
PLAN_SCHEMA_VERSION = 1
SNAPSHOT_SCHEMA_VERSION = 1
TARGET_PROJECT_IDS = (50, 174)
EXPECTED_TARGET_OUTPUT_BASELINE = {
    50: (160, 53_361_440),
    174: (0, 0),
}
PROJECT_ACKNOWLEDGEMENT = "50,174"
EXPIRY_WINDOW_HOURS = 24
CHUNK_SIZE = 1024 * 1024
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600


class SnapshotConfigurationError(RuntimeError):
    """命令或 reviewed artifact 不符合本次正式切換契約。"""


class SnapshotPreflightError(RuntimeError):
    """任何 R2 mutation 前的資料或 inventory guard 失敗。"""


class SnapshotOperationError(RuntimeError):
    """私有快照、稽核或還原未完整成功。"""


@dataclass(frozen=True)
class R2Binding:
    bucket: str
    key_prefix: str
    account_id: str
    endpoint_url: str


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        while chunk := source_file.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_json_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _normalize_etag(value: Any) -> str:
    return str(value or "").strip('"')


def _normalize_last_modified(value: Any) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise SnapshotOperationError("R2 inventory LastModified 格式錯誤")
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _normalize_storage_key(value: str) -> str:
    if not value or value.startswith("/") or "\\" in value:
        raise SnapshotPreflightError("DB 含不安全的 storage key")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise SnapshotPreflightError("DB 含不安全的 storage key")
    normalized = path.as_posix()
    if normalized != value:
        raise SnapshotPreflightError("DB storage key 尚未正規化")
    return normalized


def _normalize_key_prefix(value: str | None) -> str:
    if not value:
        return ""
    normalized = _normalize_storage_key(value.strip("/"))
    return normalized


def _prefix_matches(prefix: str, key: str) -> bool:
    return key == prefix or key.startswith(prefix + "/")


def _matches_any_prefix(key: str, prefixes: Iterable[str]) -> bool:
    return any(_prefix_matches(prefix, key) for prefix in prefixes)


def _minimize_prefixes(prefixes: Iterable[str]) -> list[str]:
    """移除已被較短 segment-boundary prefix 完整涵蓋的重複 scope。"""
    selected: list[str] = []
    for prefix in sorted(set(prefixes), key=lambda value: (value.count("/"), value)):
        if not _matches_any_prefix(prefix, selected):
            selected.append(prefix)
    return sorted(selected)


def _matches_mutable_scope(
    key: str,
    *,
    prefixes: Iterable[str],
    exact_keys: set[str],
) -> bool:
    return key in exact_keys or _matches_any_prefix(key, prefixes)


def _physical_key(binding: R2Binding, logical_key: str) -> str:
    return f"{binding.key_prefix}/{logical_key}" if binding.key_prefix else logical_key


def _logical_key(binding: R2Binding, physical_key: str) -> str:
    if not binding.key_prefix:
        return physical_key
    namespace = binding.key_prefix + "/"
    if not physical_key.startswith(namespace):
        raise SnapshotOperationError("R2 inventory 回傳 bucket namespace 外的 key")
    return physical_key.removeprefix(namespace)


def _load_env_file(path: Path | None) -> None:
    if path is None or not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SnapshotConfigurationError(f"缺少必要環境變數 {name}")
    return value


def _make_s3_client():
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise SnapshotConfigurationError("正式 image 缺少 boto3") from error

    account_id = _require_env("R2_ACCOUNT_ID")
    endpoint_url = os.getenv("R2_ENDPOINT_URL") or (
        f"https://{account_id}.r2.cloudflarestorage.com"
    )
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=_require_env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=_require_env("R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(retries={"max_attempts": 5, "mode": "standard"}),
    )


def _r2_binding_from_env() -> R2Binding:
    account_id = _require_env("R2_ACCOUNT_ID")
    return R2Binding(
        bucket=_require_env("R2_BUCKET"),
        key_prefix=_normalize_key_prefix(os.getenv("R2_KEY_PREFIX")),
        account_id=account_id,
        endpoint_url=os.getenv("R2_ENDPOINT_URL")
        or f"https://{account_id}.r2.cloudflarestorage.com",
    )


def _validate_database_single_file(database_path: Path) -> Path:
    resolved = database_path.resolve()
    if not resolved.is_file():
        raise SnapshotConfigurationError("database 不存在或不是檔案")
    for suffix in ("-wal", "-shm"):
        if resolved.with_name(resolved.name + suffix).exists():
            raise SnapshotConfigurationError("database 不可帶 SQLite sidecar")
    return resolved


def _open_readonly_database(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(
        f"{database_path.as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def _sqlite_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _query_expiring_projects(
    connection: sqlite3.Connection,
    *,
    window_started_at: datetime,
    window_ends_at: datetime,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """SELECT id, archive_expires_at
           FROM projects
           WHERE deleted_at IS NOT NULL
             AND archive_expires_at IS NOT NULL
             AND datetime(archive_expires_at) > datetime(?)
             AND datetime(archive_expires_at) <= datetime(?)
           ORDER BY id""",
        (
            _sqlite_timestamp(window_started_at),
            _sqlite_timestamp(window_ends_at),
        ),
    ).fetchall()
    return [
        {
            "project_id": int(row["id"]),
            "archive_expires_at": str(row["archive_expires_at"]),
        }
        for row in rows
    ]


def _count_expired_archived_projects(
    connection: sqlite3.Connection,
    *,
    observed_at: datetime,
) -> int:
    row = connection.execute(
        """SELECT COUNT(*)
           FROM projects
           WHERE deleted_at IS NOT NULL
             AND archive_expires_at IS NOT NULL
             AND datetime(archive_expires_at) <= datetime(?)""",
        (_sqlite_timestamp(observed_at),),
    ).fetchone()
    assert row is not None
    return int(row[0])


def _database_scope_plan(
    database_path: Path,
    *,
    window_started_at: datetime,
    window_ends_at: datetime,
    require_no_expired: bool,
) -> dict[str, Any]:
    with _open_readonly_database(database_path) as connection:
        integrity_rows = connection.execute("PRAGMA integrity_check").fetchall()
        if [tuple(row) for row in integrity_rows] != [("ok",)]:
            raise SnapshotPreflightError("database integrity_check 未通過")
        project_rows = connection.execute(
            """SELECT id, deleted_at, archive_expires_at
               FROM projects WHERE id IN (?, ?) ORDER BY id""",
            TARGET_PROJECT_IDS,
        ).fetchall()
        if tuple(int(row["id"]) for row in project_rows) != TARGET_PROJECT_IDS:
            raise SnapshotPreflightError("database 缺少指定 Project")
        if any(
            row["deleted_at"] is not None or row["archive_expires_at"] is not None
            for row in project_rows
        ):
            raise SnapshotPreflightError("指定 Project 必須是 active")
        student_rows = connection.execute(
            """SELECT id, project_id, output_filename
               FROM students
               WHERE project_id IN (?, ?)
               ORDER BY project_id, id""",
            TARGET_PROJECT_IDS,
        ).fetchall()
        student_counts = {
            project_id: sum(
                int(row["project_id"]) == project_id for row in student_rows
            )
            for project_id in TARGET_PROJECT_IDS
        }
        if any(count <= 0 for count in student_counts.values()):
            raise SnapshotPreflightError("指定 Project 沒有學生")
        expired_count = _count_expired_archived_projects(
            connection,
            observed_at=window_started_at,
        )
        if require_no_expired and expired_count:
            raise SnapshotPreflightError("已有到期但尚未清除的封存 Project")
        expiring_projects = _query_expiring_projects(
            connection,
            window_started_at=window_started_at,
            window_ends_at=window_ends_at,
        )

    recovery_prefixes = [
        get_project_output_prefix(project_id) for project_id in TARGET_PROJECT_IDS
    ]
    mutable_prefixes = [
        get_student_output_prefix(int(row["project_id"]), int(row["id"]))
        for row in student_rows
    ]
    mutable_exact_keys: set[str] = set()
    for row in student_rows:
        output_filename = row["output_filename"]
        if output_filename is None:
            continue
        if not isinstance(output_filename, str) or not output_filename.strip():
            raise SnapshotPreflightError("output_filename 格式錯誤")
        output_filename = _normalize_storage_key(output_filename)
        if student_output_prefix_from_pdf_key(output_filename) is not None:
            continue
        project_output_prefix = get_project_output_prefix(int(row["project_id"]))
        if not _prefix_matches(project_output_prefix, output_filename):
            raise SnapshotPreflightError("舊版 output_filename 超出所屬 Project output")
        mutable_exact_keys.update({
            output_filename,
            student_pdf_key_for_mode(output_filename, "screen"),
        })
        mutable_prefixes.append(str(PurePosixPath(output_filename).with_suffix("")))

    expiring_project_prefixes = [
        f"projects/proj{item['project_id']}" for item in expiring_projects
    ]
    recovery_prefixes.extend(expiring_project_prefixes)
    mutable_prefixes.extend(expiring_project_prefixes)
    recovery_prefixes = _minimize_prefixes(recovery_prefixes)
    mutable_prefixes = _minimize_prefixes(mutable_prefixes)
    for prefix in recovery_prefixes + mutable_prefixes:
        _normalize_storage_key(prefix)
    for key in mutable_exact_keys:
        _normalize_storage_key(key)
    if any(
        not _matches_any_prefix(prefix, recovery_prefixes)
        for prefix in mutable_prefixes
    ) or any(
        not _matches_any_prefix(key, recovery_prefixes)
        for key in mutable_exact_keys
    ):
        raise SnapshotPreflightError("mutable scope 超出 recovery scope")

    payload = {
        "target_project_ids": list(TARGET_PROJECT_IDS),
        "target_student_counts": {
            str(project_id): student_counts[project_id]
            for project_id in TARGET_PROJECT_IDS
        },
        "target_student_ids": {
            str(project_id): [
                int(row["id"])
                for row in student_rows
                if int(row["project_id"]) == project_id
            ]
            for project_id in TARGET_PROJECT_IDS
        },
        "expiry_window_started_at": window_started_at.isoformat(),
        "expiry_window_ends_at": window_ends_at.isoformat(),
        "expired_archived_project_count": expired_count,
        "expiring_projects": expiring_projects,
        "recovery_prefixes": recovery_prefixes,
        "mutable_prefixes": mutable_prefixes,
        "mutable_exact_keys": sorted(mutable_exact_keys),
    }
    payload["scope_sha256"] = _canonical_json_sha256(payload)
    return payload


def _list_bucket_objects(
    s3_client,
    binding: R2Binding,
) -> list[dict[str, Any]]:
    paginator = s3_client.get_paginator("list_objects_v2")
    parameters: dict[str, Any] = {"Bucket": binding.bucket}
    if binding.key_prefix:
        parameters["Prefix"] = binding.key_prefix + "/"
    objects: list[dict[str, Any]] = []
    try:
        for page in paginator.paginate(**parameters):
            for item in page.get("Contents", []):
                logical_key = _logical_key(binding, str(item["Key"]))
                _normalize_storage_key(logical_key)
                objects.append({
                    "key": logical_key,
                    "size": int(item["Size"]),
                    "etag": _normalize_etag(item.get("ETag")),
                    "last_modified": _normalize_last_modified(item.get("LastModified")),
                })
    except Exception as error:
        raise SnapshotOperationError("R2 bucket inventory 讀取失敗") from error
    objects.sort(key=lambda item: item["key"])
    if len({item["key"] for item in objects}) != len(objects):
        raise SnapshotOperationError("R2 bucket inventory 含重複 key")
    return objects


def _inventory_summary(objects: Iterable[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(
        (
            {
                "key": str(item["key"]),
                "size": int(item["size"]),
                "etag": str(item["etag"]),
                "last_modified": str(item["last_modified"]),
            }
            for item in objects
        ),
        key=lambda item: item["key"],
    )
    return {
        "object_count": len(ordered),
        "total_bytes": sum(item["size"] for item in ordered),
        "ordered_key_size_etag_last_modified_sha256": _canonical_json_sha256(ordered),
    }


def _assert_target_output_baseline(inventory: dict[str, Any]) -> None:
    scopes = {item["prefix"]: item for item in inventory["recovery_scopes"]}
    for project_id, (expected_count, expected_bytes) in EXPECTED_TARGET_OUTPUT_BASELINE.items():
        scope = scopes.get(get_project_output_prefix(project_id))
        if scope is None or (
            scope["object_count"], scope["total_bytes"]
        ) != (expected_count, expected_bytes):
            raise SnapshotPreflightError(
                f"Project {project_id} output baseline count/bytes 不符正式 reviewed contract"
            )


def _build_inventory_contract(
    objects: list[dict[str, Any]],
    scope_plan: dict[str, Any],
) -> dict[str, Any]:
    recovery_prefixes = scope_plan["recovery_prefixes"]
    mutable_prefixes = scope_plan["mutable_prefixes"]
    mutable_exact_keys = set(scope_plan["mutable_exact_keys"])
    recovery_objects = [
        item for item in objects
        if _matches_any_prefix(item["key"], recovery_prefixes)
    ]
    outside_objects = [
        item for item in objects
        if not _matches_any_prefix(item["key"], recovery_prefixes)
    ]
    immutable_recovery_objects = [
        item for item in recovery_objects
        if not _matches_mutable_scope(
            item["key"],
            prefixes=mutable_prefixes,
            exact_keys=mutable_exact_keys,
        )
    ]
    per_recovery_scope = []
    for prefix in recovery_prefixes:
        scoped_objects = [
            item for item in objects if _prefix_matches(prefix, item["key"])
        ]
        per_recovery_scope.append({
            "prefix": prefix,
            **_inventory_summary(scoped_objects),
        })
    return {
        "full_bucket": _inventory_summary(objects),
        "outside_recovery_scopes": _inventory_summary(outside_objects),
        "immutable_within_recovery_scopes": _inventory_summary(
            immutable_recovery_objects
        ),
        "recovery_scopes": per_recovery_scope,
        "recovery_objects": recovery_objects,
    }


def _binding_payload(binding: R2Binding) -> dict[str, str]:
    return {
        "bucket": binding.bucket,
        "key_prefix": binding.key_prefix,
        "account_id": binding.account_id,
        "endpoint_url": binding.endpoint_url,
    }


def _binding_from_manifest(manifest: dict[str, Any]) -> R2Binding:
    r2_payload = manifest.get("r2")
    if not isinstance(r2_payload, dict):
        raise SnapshotConfigurationError("manifest 缺少 R2 binding")
    bucket = r2_payload.get("bucket")
    key_prefix = r2_payload.get("key_prefix")
    account_id = r2_payload.get("account_id")
    endpoint_url = r2_payload.get("endpoint_url")
    if not isinstance(bucket, str) or not bucket:
        raise SnapshotConfigurationError("manifest R2 bucket 格式錯誤")
    if not isinstance(key_prefix, str):
        raise SnapshotConfigurationError("manifest R2 key prefix 格式錯誤")
    if not isinstance(account_id, str) or not account_id:
        raise SnapshotConfigurationError("manifest R2 account id 格式錯誤")
    if not isinstance(endpoint_url, str) or not endpoint_url:
        raise SnapshotConfigurationError("manifest R2 endpoint 格式錯誤")
    return R2Binding(
        bucket=bucket,
        key_prefix=_normalize_key_prefix(key_prefix),
        account_id=account_id,
        endpoint_url=endpoint_url,
    )


def _assert_binding_matches(manifest: dict[str, Any], binding: R2Binding) -> None:
    if _binding_from_manifest(manifest) != binding:
        raise SnapshotPreflightError("目前 R2 binding 與 reviewed manifest 不符")


def _validate_private_directory(path: Path, *, allow_nonempty: bool) -> Path:
    if not path.is_absolute():
        raise SnapshotConfigurationError("snapshot-dir 必須是絕對路徑")
    resolved = path.resolve()
    if resolved == ROOT_DIR or resolved.is_relative_to(ROOT_DIR):
        raise SnapshotConfigurationError("snapshot-dir 必須位於 repo 外")
    if resolved.exists():
        if not resolved.is_dir() or resolved.is_symlink():
            raise SnapshotConfigurationError("snapshot-dir 必須是實體目錄")
        if not allow_nonempty and any(resolved.iterdir()):
            raise SnapshotConfigurationError("新的 snapshot-dir 必須為空")
    else:
        resolved.mkdir(parents=True, mode=PRIVATE_DIRECTORY_MODE)
    os.chmod(resolved, PRIVATE_DIRECTORY_MODE)
    if os.name != "nt" and stat.S_IMODE(resolved.stat().st_mode) != PRIVATE_DIRECTORY_MODE:
        raise SnapshotConfigurationError("snapshot-dir 權限不是 0700")
    return resolved


def _write_private_manifest(path: Path, manifest: dict[str, Any]) -> None:
    write_manifest(path, manifest)
    os.chmod(path, PRIVATE_FILE_MODE)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    directory_descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


@contextmanager
def _snapshot_directory_lock(snapshot_dir: Path):
    """同一私有快照目錄一次只允許一個跨程序操作。"""
    lock_path = snapshot_dir / ".r2-snapshot.lock"
    lock_file = lock_path.open("a+b")
    os.chmod(lock_path, PRIVATE_FILE_MODE)
    acquired = False
    try:
        try:
            if os.name == "nt":
                import msvcrt

                lock_file.seek(0)
                if lock_file.read(1) == b"":
                    lock_file.write(b"0")
                    lock_file.flush()
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError as error:
            raise SnapshotPreflightError("同一 snapshot-dir 已有操作執行中") from error
        yield
    finally:
        try:
            if acquired and os.name == "nt":
                import msvcrt

                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
            elif acquired:
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()


def _load_reviewed_manifest(
    path: Path,
    expected_sha256: str,
    *,
    expected_schema_version: int,
    expected_artifact: str,
) -> tuple[dict[str, Any], str]:
    if not path.is_file():
        raise SnapshotConfigurationError("reviewed manifest 不存在")
    observed_sha256 = _file_sha256(path)
    if observed_sha256 != expected_sha256.lower():
        raise SnapshotConfigurationError("reviewed manifest SHA-256 不符")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SnapshotConfigurationError("reviewed manifest 不是有效 JSON") from error
    if (
        not isinstance(manifest, dict)
        or manifest.get("operation") != OPERATION
        or manifest.get("artifact") != expected_artifact
        or manifest.get("schema_version") != expected_schema_version
    ):
        raise SnapshotConfigurationError("reviewed manifest 契約不符")
    return manifest, observed_sha256


def _database_binding_payload(database_path: Path) -> dict[str, Any]:
    return {
        "path": str(database_path),
        "size_bytes": database_path.stat().st_size,
        "sha256": _file_sha256(database_path),
    }


def _assert_database_binding(
    database_path: Path,
    manifest: dict[str, Any],
) -> None:
    expected = manifest.get("database")
    observed = _database_binding_payload(database_path)
    if expected != observed:
        raise SnapshotPreflightError("database path、size 或 SHA-256 已漂移")


def create_plan(
    *,
    database_path: Path,
    snapshot_dir: Path,
    cutover_id: str,
    s3_client,
    binding: R2Binding,
    observed_at: datetime | None = None,
) -> tuple[dict[str, Any], Path]:
    observed_at = observed_at or datetime.now(timezone.utc)
    window_ends_at = observed_at + timedelta(hours=EXPIRY_WINDOW_HOURS)
    database_path = _validate_database_single_file(database_path)
    snapshot_dir = _validate_private_directory(snapshot_dir, allow_nonempty=False)
    scope_plan = _database_scope_plan(
        database_path,
        window_started_at=observed_at,
        window_ends_at=window_ends_at,
        require_no_expired=True,
    )
    database_binding = _database_binding_payload(database_path)
    objects = _list_bucket_objects(s3_client, binding)
    inventory = _build_inventory_contract(objects, scope_plan)
    _assert_target_output_baseline(inventory)
    manifest = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "operation": OPERATION,
        "artifact": "reviewed-plan",
        "mode": "read-only-plan",
        "overall_status": "review_required",
        "created_at": utc_now_iso(),
        "cutover_id": cutover_id,
        "contains_personal_data": True,
        "privacy_notice": "完整 key 僅可留在 repo 外 0700 私有目錄",
        "snapshot_dir": str(snapshot_dir),
        "database": database_binding,
        "r2": _binding_payload(binding),
        "inventory_namespace": (
            {"kind": "key_prefix", "key_prefix": binding.key_prefix}
            if binding.key_prefix
            else {"kind": "full_bucket"}
        ),
        "scope_plan": scope_plan,
        "inventory": inventory,
    }
    plan_path = snapshot_dir / "reviewed-plan.json"
    _write_private_manifest(plan_path, manifest)
    return manifest, plan_path


def _assert_plan_scope_matches_database(
    database_path: Path,
    plan: dict[str, Any],
) -> None:
    _assert_database_binding(database_path, plan)
    _assert_fixed_scope_matches_database(database_path, plan["scope_plan"])
    scope_plan = plan["scope_plan"]

    current_time = datetime.now(timezone.utc)
    with _open_readonly_database(database_path) as connection:
        if _count_expired_archived_projects(connection, observed_at=current_time):
            raise SnapshotPreflightError("snapshot 開始時已有到期封存 Project")
        current_risk = _query_expiring_projects(
            connection,
            window_started_at=current_time,
            window_ends_at=current_time + timedelta(hours=EXPIRY_WINDOW_HOURS),
        )
    covered_ids = {
        int(item["project_id"]) for item in scope_plan["expiring_projects"]
    }
    if any(int(item["project_id"]) not in covered_ids for item in current_risk):
        raise SnapshotPreflightError("新的 24 小時內到期 Project 尚未納入 plan")


def _assert_fixed_scope_matches_database(
    database_path: Path,
    scope_plan: dict[str, Any],
) -> None:
    """以 plan 固定的時間窗重算 scope，不受 restore 當下時鐘推進影響。"""
    started_at = datetime.fromisoformat(scope_plan["expiry_window_started_at"])
    ends_at = datetime.fromisoformat(scope_plan["expiry_window_ends_at"])
    observed = _database_scope_plan(
        database_path,
        window_started_at=started_at,
        window_ends_at=ends_at,
        require_no_expired=False,
    )
    if observed != scope_plan:
        raise SnapshotPreflightError("database 推導的 target scope 已漂移")


def _assert_restore_database_safe(
    database_path: Path,
    scope_plan: dict[str, Any],
) -> None:
    """rollback 可處於 post-migration DB；只釘 schema、active targets 與學生集合。"""
    with _open_readonly_database(database_path) as connection:
        integrity_rows = connection.execute("PRAGMA integrity_check").fetchall()
        if [tuple(row) for row in integrity_rows] != [("ok",)]:
            raise SnapshotPreflightError("restore database integrity_check 未通過")
        project_rows = connection.execute(
            """SELECT id, deleted_at, archive_expires_at FROM projects
               WHERE id IN (?, ?) ORDER BY id""",
            TARGET_PROJECT_IDS,
        ).fetchall()
        if tuple(int(row["id"]) for row in project_rows) != TARGET_PROJECT_IDS:
            raise SnapshotPreflightError("restore database 缺少指定 Project")
        if any(
            row["deleted_at"] is not None or row["archive_expires_at"] is not None
            for row in project_rows
        ):
            raise SnapshotPreflightError("restore 指定 Project 不是 active")
        student_rows = connection.execute(
            """SELECT id, project_id FROM students
               WHERE project_id IN (?, ?) ORDER BY project_id, id""",
            TARGET_PROJECT_IDS,
        ).fetchall()
    observed_ids = {
        project_id: [
            int(row["id"])
            for row in student_rows
            if int(row["project_id"]) == project_id
        ]
        for project_id in TARGET_PROJECT_IDS
    }
    expected_ids = {
        int(project_id): [int(student_id) for student_id in student_ids]
        for project_id, student_ids in scope_plan["target_student_ids"].items()
    }
    if observed_ids != expected_ids:
        raise SnapshotPreflightError("restore target Student 集合已漂移")


def _inventory_contract_without_objects(contract: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value for key, value in contract.items() if key != "recovery_objects"
    }


def _assert_inventory_matches_plan(
    objects: list[dict[str, Any]],
    plan: dict[str, Any],
) -> dict[str, Any]:
    observed = _build_inventory_contract(objects, plan["scope_plan"])
    expected = plan["inventory"]
    if observed != expected:
        raise SnapshotPreflightError("R2 inventory 與 reviewed plan 已漂移")
    return observed


def _object_headers(response: dict[str, Any]) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    for name in (
        "ContentType",
        "CacheControl",
        "ContentDisposition",
        "ContentEncoding",
        "ContentLanguage",
        "Expires",
    ):
        value = response.get(name)
        if value is not None:
            headers[name] = value.isoformat() if isinstance(value, datetime) else str(value)
    metadata = response.get("Metadata")
    if isinstance(metadata, dict) and metadata:
        headers["Metadata"] = {
            str(key): str(value) for key, value in metadata.items()
        }
    return headers


def _stream_object_to_blob(
    *,
    s3_client,
    binding: R2Binding,
    object_entry: dict[str, Any],
    blobs_dir: Path,
    object_index: int,
) -> dict[str, Any]:
    try:
        response = s3_client.get_object(
            Bucket=binding.bucket,
            Key=_physical_key(binding, object_entry["key"]),
        )
    except Exception as error:
        raise SnapshotOperationError(
            f"第 {object_index} 個 target object 下載失敗"
        ) from error
    if (
        int(response.get("ContentLength", -1)) != object_entry["size"]
        or _normalize_etag(response.get("ETag")) != object_entry["etag"]
    ):
        raise SnapshotPreflightError(
            f"第 {object_index} 個 target object 在下載前已漂移"
        )
    temporary_path = blobs_dir / f".download-{object_index}.tmp"
    digest = hashlib.sha256()
    size = 0
    body = response["Body"]
    try:
        try:
            with temporary_path.open("wb") as blob_file:
                while chunk := body.read(CHUNK_SIZE):
                    blob_file.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
                blob_file.flush()
                os.fsync(blob_file.fileno())
        except Exception as error:
            temporary_path.unlink(missing_ok=True)
            raise SnapshotOperationError(
                f"第 {object_index} 個 target object 串流下載失敗"
            ) from error
    finally:
        close = getattr(body, "close", None)
        if close:
            close()
    if size != object_entry["size"]:
        temporary_path.unlink(missing_ok=True)
        raise SnapshotOperationError(
            f"第 {object_index} 個 target object 下載長度不符"
        )
    content_sha256 = digest.hexdigest()
    blob_path = blobs_dir / content_sha256
    if blob_path.exists():
        if blob_path.stat().st_size != size or _file_sha256(blob_path) != content_sha256:
            temporary_path.unlink(missing_ok=True)
            raise SnapshotOperationError("既有 content-addressed blob 驗證失敗")
        temporary_path.unlink()
    else:
        os.replace(temporary_path, blob_path)
        os.chmod(blob_path, PRIVATE_FILE_MODE)
        _fsync_directory(blobs_dir)
    return {
        **object_entry,
        "content_sha256": content_sha256,
        "blob": f"blobs/{content_sha256}",
        "headers": _object_headers(response),
    }


def _create_snapshot_unlocked(
    *,
    database_path: Path,
    plan_path: Path,
    plan_sha256: str,
    acknowledgement: str,
    s3_client,
    binding: R2Binding,
) -> tuple[dict[str, Any], Path]:
    if acknowledgement != PROJECT_ACKNOWLEDGEMENT:
        raise SnapshotConfigurationError("snapshot acknowledgement 必須精確為 50,174")
    plan, observed_plan_sha256 = _load_reviewed_manifest(
        plan_path,
        plan_sha256,
        expected_schema_version=PLAN_SCHEMA_VERSION,
        expected_artifact="reviewed-plan",
    )
    database_path = _validate_database_single_file(database_path)
    _assert_binding_matches(plan, binding)
    _assert_plan_scope_matches_database(database_path, plan)
    snapshot_dir = _validate_private_directory(
        Path(plan["snapshot_dir"]), allow_nonempty=True
    )
    if plan_path.resolve().parent != snapshot_dir:
        raise SnapshotConfigurationError("reviewed plan 不在其綁定的 snapshot-dir")
    snapshot_path = snapshot_dir / "snapshot-manifest.json"
    if snapshot_path.exists():
        raise SnapshotConfigurationError("snapshot manifest 已存在")
    blobs_dir = snapshot_dir / "blobs"
    blobs_dir.mkdir(mode=PRIVATE_DIRECTORY_MODE, exist_ok=True)
    os.chmod(blobs_dir, PRIVATE_DIRECTORY_MODE)

    before_objects = _list_bucket_objects(s3_client, binding)
    inventory = _assert_inventory_matches_plan(before_objects, plan)
    snapshot_objects = []
    for object_index, object_entry in enumerate(
        inventory["recovery_objects"], start=1
    ):
        snapshot_objects.append(_stream_object_to_blob(
            s3_client=s3_client,
            binding=binding,
            object_entry=object_entry,
            blobs_dir=blobs_dir,
            object_index=object_index,
        ))
    after_objects = _list_bucket_objects(s3_client, binding)
    _assert_inventory_matches_plan(after_objects, plan)
    _validate_database_single_file(database_path)
    _assert_plan_scope_matches_database(database_path, plan)
    manifest = {
        "schema_version": SNAPSHOT_SCHEMA_VERSION,
        "operation": OPERATION,
        "artifact": "private-snapshot",
        "mode": "snapshot",
        "overall_status": "complete",
        "created_at": utc_now_iso(),
        "cutover_id": plan["cutover_id"],
        "contains_personal_data": True,
        "snapshot_dir": str(snapshot_dir),
        "reviewed_plan_path": str(plan_path.resolve()),
        "reviewed_plan_sha256": observed_plan_sha256,
        "database": plan["database"],
        "r2": plan["r2"],
        "inventory_namespace": plan["inventory_namespace"],
        "scope_plan": plan["scope_plan"],
        "inventory": _inventory_contract_without_objects(plan["inventory"]),
        "objects": snapshot_objects,
        "snapshot_object_count": len(snapshot_objects),
        "snapshot_total_bytes": sum(item["size"] for item in snapshot_objects),
        "snapshot_content_contract_sha256": _canonical_json_sha256([
            {
                "key": item["key"],
                "size": item["size"],
                "content_sha256": item["content_sha256"],
            }
            for item in snapshot_objects
        ]),
    }
    _write_private_manifest(snapshot_path, manifest)
    return manifest, snapshot_path


def create_snapshot(**arguments):
    plan, _sha256 = _load_reviewed_manifest(
        arguments["plan_path"], arguments["plan_sha256"],
        expected_schema_version=PLAN_SCHEMA_VERSION,
        expected_artifact="reviewed-plan",
    )
    snapshot_dir = _validate_private_directory(Path(plan["snapshot_dir"]), allow_nonempty=True)
    with _snapshot_directory_lock(snapshot_dir):
        return _create_snapshot_unlocked(**arguments)


def _validate_snapshot_blobs(
    snapshot: dict[str, Any], snapshot_path: Path
) -> Path:
    snapshot_dir = _validate_private_directory(
        Path(snapshot["snapshot_dir"]), allow_nonempty=True
    )
    if snapshot_path.resolve().parent != snapshot_dir:
        raise SnapshotConfigurationError("snapshot manifest 不在綁定的私有目錄")
    scope_plan = snapshot.get("scope_plan")
    if not isinstance(scope_plan, dict):
        raise SnapshotConfigurationError("snapshot scope plan 格式錯誤")
    scope_without_hash = dict(scope_plan)
    stored_scope_sha256 = scope_without_hash.pop("scope_sha256", None)
    if stored_scope_sha256 != _canonical_json_sha256(scope_without_hash):
        raise SnapshotConfigurationError("snapshot scope SHA-256 不符")
    expected_recovery_prefixes = _minimize_prefixes([
        *(get_project_output_prefix(project_id) for project_id in TARGET_PROJECT_IDS),
        *(
            f"projects/proj{int(item['project_id'])}"
            for item in scope_plan.get("expiring_projects", [])
        ),
    ])
    if scope_plan.get("recovery_prefixes") != expected_recovery_prefixes:
        raise SnapshotConfigurationError("snapshot recovery prefixes 契約不符")
    objects = snapshot.get("objects")
    if not isinstance(objects, list):
        raise SnapshotConfigurationError("snapshot object 清單格式錯誤")
    if len(objects) != snapshot.get("snapshot_object_count"):
        raise SnapshotConfigurationError("snapshot object count 不符")
    seen_keys: set[str] = set()
    observed_total_bytes = 0
    for object_entry in objects:
        if not isinstance(object_entry, dict):
            raise SnapshotConfigurationError("snapshot object 格式錯誤")
        raw_key = object_entry.get("key")
        if not isinstance(raw_key, str):
            raise SnapshotConfigurationError("snapshot object key 格式錯誤")
        key = _normalize_storage_key(raw_key)
        if key in seen_keys:
            raise SnapshotConfigurationError("snapshot object key 重複")
        seen_keys.add(key)
        object_size = object_entry.get("size")
        if (
            not isinstance(object_size, int)
            or isinstance(object_size, bool)
            or object_size < 0
            or not isinstance(object_entry.get("etag"), str)
            or not isinstance(object_entry.get("last_modified"), str)
        ):
            raise SnapshotConfigurationError("snapshot object metadata 格式錯誤")
        observed_total_bytes += object_size
        headers = object_entry.get("headers")
        if not isinstance(headers, dict) or any(
            name not in {
                "ContentType",
                "CacheControl",
                "ContentDisposition",
                "ContentEncoding",
                "ContentLanguage",
                "Expires",
                "Metadata",
            }
            for name in headers
        ):
            raise SnapshotConfigurationError("snapshot object headers 格式錯誤")
        if any(
            name != "Metadata" and not isinstance(value, str)
            for name, value in headers.items()
        ):
            raise SnapshotConfigurationError("snapshot object header value 格式錯誤")
        metadata = headers.get("Metadata", {})
        if not isinstance(metadata, dict) or any(
            not isinstance(name, str) or not isinstance(value, str)
            for name, value in metadata.items()
        ):
            raise SnapshotConfigurationError("snapshot object user metadata 格式錯誤")
        content_sha256 = object_entry.get("content_sha256")
        if (
            not isinstance(content_sha256, str)
            or len(content_sha256) != 64
            or object_entry.get("blob") != f"blobs/{content_sha256}"
        ):
            raise SnapshotConfigurationError("snapshot blob contract 格式錯誤")
        blob_path = snapshot_dir / "blobs" / content_sha256
        if (
            not blob_path.is_file()
            or blob_path.stat().st_size != object_entry.get("size")
            or _file_sha256(blob_path) != content_sha256
        ):
            raise SnapshotPreflightError("snapshot blob size 或 SHA-256 不符")
    if observed_total_bytes != snapshot.get("snapshot_total_bytes"):
        raise SnapshotConfigurationError("snapshot total bytes 不符")
    expected_contract = _canonical_json_sha256([
        {
            "key": item["key"],
            "size": item["size"],
            "content_sha256": item["content_sha256"],
        }
        for item in objects
    ])
    if expected_contract != snapshot.get("snapshot_content_contract_sha256"):
        raise SnapshotConfigurationError("snapshot content contract SHA-256 不符")
    return snapshot_dir


def _audit_inventory(
    snapshot: dict[str, Any],
    current_objects: list[dict[str, Any]],
    metadata_drift_keys: set[str] | None = None,
) -> dict[str, Any]:
    metadata_drift_keys = metadata_drift_keys or set()
    observed = _build_inventory_contract(current_objects, snapshot["scope_plan"])
    baseline = snapshot["inventory"]
    outside_matches = (
        observed["outside_recovery_scopes"]
        == baseline["outside_recovery_scopes"]
    )
    immutable_matches = (
        observed["immutable_within_recovery_scopes"]
        == baseline["immutable_within_recovery_scopes"]
    ) and not any(
        not _matches_mutable_scope(
            key,
            prefixes=snapshot["scope_plan"]["mutable_prefixes"],
            exact_keys=set(snapshot["scope_plan"]["mutable_exact_keys"]),
        )
        for key in metadata_drift_keys
    )
    baseline_scopes = {
        item["prefix"]: item for item in baseline["recovery_scopes"]
    }
    changed_scopes = [
        item["prefix"]
        for item in observed["recovery_scopes"]
        if item != baseline_scopes.get(item["prefix"])
    ]
    changed_scopes = sorted(set(changed_scopes) | {
        prefix
        for prefix in snapshot["scope_plan"]["recovery_prefixes"]
        if any(_prefix_matches(prefix, key) for key in metadata_drift_keys)
    })
    return {
        "status": "passed" if outside_matches and immutable_matches else "failed",
        "outside_recovery_scopes_match": outside_matches,
        "immutable_within_recovery_scopes_match": immutable_matches,
        "changed_recovery_prefixes": changed_scopes,
        "changed_recovery_scope_count": len(changed_scopes),
        "current_inventory": _inventory_contract_without_objects(observed),
    }


def _recovery_metadata_drift_keys(
    snapshot, s3_client, binding: R2Binding, current_objects: list[dict[str, Any]]
) -> set[str]:
    drift: set[str] = set()
    current_keys = {item["key"] for item in current_objects}
    for object_index, item in enumerate(snapshot["objects"], start=1):
        if item["key"] not in current_keys:
            drift.add(item["key"])
            continue
        try:
            response = s3_client.head_object(
                Bucket=binding.bucket,
                Key=_physical_key(binding, item["key"]),
            )
        except Exception as error:
            raise SnapshotOperationError(
                f"第 {object_index} 個 recovery object metadata 讀取失敗"
            ) from error
        if _object_headers(response) != item["headers"]:
            drift.add(item["key"])
    return drift


def _audit_after_unlocked(
    *,
    snapshot_path: Path,
    snapshot_sha256: str,
    s3_client,
    binding: R2Binding,
) -> tuple[dict[str, Any], Path]:
    snapshot, observed_snapshot_sha256 = _load_reviewed_manifest(
        snapshot_path,
        snapshot_sha256,
        expected_schema_version=SNAPSHOT_SCHEMA_VERSION,
        expected_artifact="private-snapshot",
    )
    snapshot_dir = _validate_snapshot_blobs(snapshot, snapshot_path)
    _assert_binding_matches(snapshot, binding)
    current_objects = _list_bucket_objects(s3_client, binding)
    audit = _audit_inventory(
        snapshot, current_objects,
        _recovery_metadata_drift_keys(snapshot, s3_client, binding, current_objects),
    )
    report = {
        "schema_version": 1,
        "operation": OPERATION,
        "artifact": "post-change-audit",
        "created_at": utc_now_iso(),
        "snapshot_manifest_sha256": observed_snapshot_sha256,
        **audit,
    }
    report_path = snapshot_dir / (
        "audit-after-"
        + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        + ".json"
    )
    _write_private_manifest(report_path, report)
    if audit["status"] != "passed":
        raise SnapshotPreflightError("R2 post-change audit 發現非允許範圍漂移")
    return report, report_path


def audit_after(**arguments):
    snapshot, _sha256 = _load_reviewed_manifest(
        arguments["snapshot_path"], arguments["snapshot_sha256"],
        expected_schema_version=SNAPSHOT_SCHEMA_VERSION,
        expected_artifact="private-snapshot",
    )
    snapshot_dir = _validate_private_directory(Path(snapshot["snapshot_dir"]), allow_nonempty=True)
    with _snapshot_directory_lock(snapshot_dir):
        return _audit_after_unlocked(**arguments)


def _verify_before_start_unlocked(
    *, database_path: Path, snapshot_path: Path, snapshot_sha256: str,
    s3_client, binding: R2Binding, observed_at: datetime | None = None,
):
    snapshot, observed_snapshot_sha256 = _load_reviewed_manifest(
        snapshot_path, snapshot_sha256,
        expected_schema_version=SNAPSHOT_SCHEMA_VERSION,
        expected_artifact="private-snapshot",
    )
    snapshot_dir = _validate_snapshot_blobs(snapshot, snapshot_path)
    database_path = _validate_database_single_file(database_path)
    _assert_database_binding(database_path, snapshot)
    _assert_restore_database_safe(database_path, snapshot["scope_plan"])
    _assert_binding_matches(snapshot, binding)
    observed_at = observed_at or datetime.now(timezone.utc)
    with _open_readonly_database(database_path) as connection:
        if _count_expired_archived_projects(connection, observed_at=observed_at):
            raise SnapshotPreflightError("candidate 啟動前已有到期封存 Project")
        current_risk = _query_expiring_projects(
            connection,
            window_started_at=observed_at,
            window_ends_at=observed_at + timedelta(hours=EXPIRY_WINDOW_HOURS),
        )
    covered_ids = {
        int(item["project_id"])
        for item in snapshot["scope_plan"]["expiring_projects"]
    }
    if any(int(item["project_id"]) not in covered_ids for item in current_risk):
        raise SnapshotPreflightError("candidate 啟動前出現未覆蓋的 24h 到期 Project")
    current_objects = _list_bucket_objects(s3_client, binding)
    audit = _audit_inventory(
        snapshot, current_objects,
        _recovery_metadata_drift_keys(snapshot, s3_client, binding, current_objects),
    )
    if (
        audit["status"] != "passed"
        or audit["changed_recovery_scope_count"] != 0
        or audit["current_inventory"]["full_bucket"]
        != snapshot["inventory"]["full_bucket"]
    ):
        raise SnapshotPreflightError("candidate 啟動前 R2 baseline 已漂移")
    report = {
        "schema_version": 1,
        "operation": OPERATION,
        "artifact": "verify-before-start",
        "overall_status": "passed",
        "created_at": utc_now_iso(),
        "snapshot_manifest_sha256": observed_snapshot_sha256,
        "expired_archived_project_count": 0,
        "covered_24h_risk_project_count": len(current_risk),
        "inventory_namespace": snapshot["inventory_namespace"],
        "full_inventory": audit["current_inventory"]["full_bucket"],
    }
    report_path = snapshot_dir / (
        "verify-before-start-"
        + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json"
    )
    _write_private_manifest(report_path, report)
    return report, report_path


def verify_before_start(**arguments):
    snapshot, _sha256 = _load_reviewed_manifest(
        arguments["snapshot_path"], arguments["snapshot_sha256"],
        expected_schema_version=SNAPSHOT_SCHEMA_VERSION,
        expected_artifact="private-snapshot",
    )
    snapshot_dir = _validate_private_directory(Path(snapshot["snapshot_dir"]), allow_nonempty=True)
    with _snapshot_directory_lock(snapshot_dir):
        return _verify_before_start_unlocked(**arguments)


def _delete_prefix(s3_client, binding: R2Binding, prefix: str) -> int:
    physical_prefix = _physical_key(binding, prefix)
    paginator = s3_client.get_paginator("list_objects_v2")
    keys: list[str] = []
    try:
        for page in paginator.paginate(
            Bucket=binding.bucket,
            Prefix=physical_prefix,
        ):
            keys.extend(
                str(item["Key"])
                for item in page.get("Contents", [])
                if _prefix_matches(
                    prefix,
                    _logical_key(binding, str(item["Key"])),
                )
            )
        for start in range(0, len(keys), 1000):
            batch = keys[start : start + 1000]
            if not batch:
                continue
            response = s3_client.delete_objects(
                Bucket=binding.bucket,
                Delete={
                    "Objects": [{"Key": key} for key in batch],
                    "Quiet": True,
                },
            )
            if response.get("Errors"):
                raise SnapshotOperationError("R2 restore delete_objects 回報失敗")
    except SnapshotOperationError:
        raise
    except Exception as error:
        raise SnapshotOperationError("R2 restore 清理 target scope 失敗") from error
    return len(keys)


def _upload_blob(
    *,
    s3_client,
    binding: R2Binding,
    snapshot_dir: Path,
    object_entry: dict[str, Any],
    object_index: int,
) -> None:
    blob_path = snapshot_dir / object_entry["blob"]
    parameters: dict[str, Any] = {
        "Bucket": binding.bucket,
        "Key": _physical_key(binding, object_entry["key"]),
    }
    headers = object_entry.get("headers")
    if isinstance(headers, dict):
        parameters.update(headers)
    try:
        with blob_path.open("rb") as blob_file:
            s3_client.put_object(Body=blob_file, **parameters)
    except Exception as error:
        raise SnapshotOperationError(
            f"第 {object_index} 個 snapshot object 還原上傳失敗"
        ) from error


def _remote_object_content_sha256(
    *,
    s3_client,
    binding: R2Binding,
    object_entry: dict[str, Any],
    object_index: int,
) -> tuple[int, str, dict[str, Any]]:
    try:
        response = s3_client.get_object(
            Bucket=binding.bucket,
            Key=_physical_key(binding, object_entry["key"]),
        )
    except Exception as error:
        raise SnapshotOperationError(
            f"第 {object_index} 個還原物件驗證下載失敗"
        ) from error
    digest = hashlib.sha256()
    size = 0
    body = response["Body"]
    try:
        try:
            while chunk := body.read(CHUNK_SIZE):
                digest.update(chunk)
                size += len(chunk)
        except Exception as error:
            raise SnapshotOperationError(
                f"第 {object_index} 個還原物件串流驗證失敗"
            ) from error
    finally:
        close = getattr(body, "close", None)
        if close:
            close()
    return size, digest.hexdigest(), _object_headers(response)


def _restore_unlocked(
    *,
    database_path: Path,
    snapshot_path: Path,
    snapshot_sha256: str,
    acknowledgement: str | None,
    apply_requested: bool,
    s3_client,
    binding: R2Binding,
) -> tuple[dict[str, Any], Path]:
    snapshot, observed_snapshot_sha256 = _load_reviewed_manifest(
        snapshot_path,
        snapshot_sha256,
        expected_schema_version=SNAPSHOT_SCHEMA_VERSION,
        expected_artifact="private-snapshot",
    )
    snapshot_dir = _validate_snapshot_blobs(snapshot, snapshot_path)
    database_path = _validate_database_single_file(database_path)
    _assert_restore_database_safe(database_path, snapshot["scope_plan"])
    _assert_binding_matches(snapshot, binding)
    expected_acknowledgement = f"{PROJECT_ACKNOWLEDGEMENT}:{snapshot['cutover_id']}"
    if apply_requested and acknowledgement != expected_acknowledgement:
        raise SnapshotConfigurationError("restore acknowledgement 不符")
    if not apply_requested and acknowledgement is not None:
        raise SnapshotConfigurationError("dry-run restore 不可帶 acknowledgement")

    before_objects = _list_bucket_objects(s3_client, binding)
    audit = _audit_inventory(
        snapshot,
        before_objects,
        _recovery_metadata_drift_keys(snapshot, s3_client, binding, before_objects),
    )
    if not audit["outside_recovery_scopes_match"]:
        raise SnapshotPreflightError("recovery scope 外 inventory 已漂移")
    changed_prefixes = audit["changed_recovery_prefixes"]
    report = {
        "schema_version": 1,
        "operation": OPERATION,
        "artifact": "restore-execution",
        "mode": "apply" if apply_requested else "dry-run",
        "overall_status": "planned" if apply_requested else "dry_run",
        "started_at": utc_now_iso(),
        "finished_at": None,
        "snapshot_manifest_sha256": observed_snapshot_sha256,
        "changed_recovery_prefixes": changed_prefixes,
        "changed_recovery_scope_count": len(changed_prefixes),
        "deleted_object_count": 0,
        "uploaded_object_count": 0,
        "verified_object_count": 0,
    }
    report_path = snapshot_dir / (
        "restore-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json"
    )
    _write_private_manifest(report_path, report)
    if not apply_requested:
        report["finished_at"] = utc_now_iso()
        _write_private_manifest(report_path, report)
        return report, report_path

    report["overall_status"] = "applying"
    _write_private_manifest(report_path, report)
    for prefix in changed_prefixes:
        report["deleted_object_count"] += _delete_prefix(
            s3_client, binding, prefix
        )
        _write_private_manifest(report_path, report)
    objects_to_restore = [
        item for item in snapshot["objects"]
        if _matches_any_prefix(item["key"], changed_prefixes)
    ]
    for object_index, object_entry in enumerate(objects_to_restore, start=1):
        _upload_blob(
            s3_client=s3_client,
            binding=binding,
            snapshot_dir=snapshot_dir,
            object_entry=object_entry,
            object_index=object_index,
        )
        report["uploaded_object_count"] += 1
        _write_private_manifest(report_path, report)

    after_objects = _list_bucket_objects(s3_client, binding)
    after_by_key = {item["key"]: item for item in after_objects}
    expected_scope_keys = {
        item["key"] for item in objects_to_restore
    }
    observed_scope_keys = {
        item["key"] for item in after_objects
        if _matches_any_prefix(item["key"], changed_prefixes)
    }
    if observed_scope_keys != expected_scope_keys:
        raise SnapshotOperationError("restore 後 target scope key 集合不符")
    for object_index, object_entry in enumerate(objects_to_restore, start=1):
        if after_by_key[object_entry["key"]]["size"] != object_entry["size"]:
            raise SnapshotOperationError("restore 後 target object size 不符")
        size, content_sha256, headers = _remote_object_content_sha256(
            s3_client=s3_client,
            binding=binding,
            object_entry=object_entry,
            object_index=object_index,
        )
        if (
            size != object_entry["size"]
            or content_sha256 != object_entry["content_sha256"]
            or headers != object_entry["headers"]
        ):
            raise SnapshotOperationError("restore 後 target object content 或 metadata 不符")
        report["verified_object_count"] += 1
        _write_private_manifest(report_path, report)
    after_audit = _audit_inventory(
        snapshot,
        after_objects,
        _recovery_metadata_drift_keys(snapshot, s3_client, binding, after_objects),
    )
    if not after_audit["outside_recovery_scopes_match"]:
        raise SnapshotOperationError("restore 期間 recovery scope 外發生漂移")
    if set(after_audit["changed_recovery_prefixes"]) - set(changed_prefixes):
        raise SnapshotOperationError("restore 期間未處理的 recovery scope 發生漂移")
    report["overall_status"] = "complete"
    report["finished_at"] = utc_now_iso()
    _write_private_manifest(report_path, report)
    return report, report_path


def restore(**arguments):
    snapshot, _sha256 = _load_reviewed_manifest(
        arguments["snapshot_path"], arguments["snapshot_sha256"],
        expected_schema_version=SNAPSHOT_SCHEMA_VERSION,
        expected_artifact="private-snapshot",
    )
    snapshot_dir = _validate_private_directory(Path(snapshot["snapshot_dir"]), allow_nonempty=True)
    with _snapshot_directory_lock(snapshot_dir):
        return _restore_unlocked(**arguments)


def _add_environment_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--env-file", type=Path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan_parser = subparsers.add_parser("plan")
    plan_parser.add_argument("--database", type=Path, required=True)
    plan_parser.add_argument("--snapshot-dir", type=Path, required=True)
    plan_parser.add_argument("--cutover-id", type=validate_run_id, required=True)
    _add_environment_arguments(plan_parser)

    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--database", type=Path, required=True)
    snapshot_parser.add_argument("--reviewed-manifest", type=Path, required=True)
    snapshot_parser.add_argument("--reviewed-manifest-sha256", required=True)
    snapshot_parser.add_argument("--acknowledge-project-ids", required=True)
    _add_environment_arguments(snapshot_parser)

    audit_parser = subparsers.add_parser("audit-after")
    audit_parser.add_argument("--snapshot-manifest", type=Path, required=True)
    audit_parser.add_argument("--snapshot-manifest-sha256", required=True)
    _add_environment_arguments(audit_parser)

    verify_parser = subparsers.add_parser("verify-before-start")
    verify_parser.add_argument("--database", type=Path, required=True)
    verify_parser.add_argument("--snapshot-manifest", type=Path, required=True)
    verify_parser.add_argument("--snapshot-manifest-sha256", required=True)
    _add_environment_arguments(verify_parser)

    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("--database", type=Path, required=True)
    restore_parser.add_argument("--snapshot-manifest", type=Path, required=True)
    restore_parser.add_argument("--snapshot-manifest-sha256", required=True)
    restore_parser.add_argument("--apply", action="store_true")
    restore_parser.add_argument("--acknowledge-restore")
    _add_environment_arguments(restore_parser)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        _load_env_file(args.env_file)
        binding = _r2_binding_from_env()
        s3_client = _make_s3_client()
        if args.command == "plan":
            manifest, artifact_path = create_plan(
                database_path=args.database,
                snapshot_dir=args.snapshot_dir,
                cutover_id=args.cutover_id,
                s3_client=s3_client,
                binding=binding,
            )
            print("R2 reviewed plan 完成（零 R2 寫入）")
            print(f"r2 account_id={manifest['r2']['account_id']}")
            print(f"r2 bucket={manifest['r2']['bucket']}")
            print(f"r2 key_prefix={manifest['r2']['key_prefix'] or '(none)'}")
            print(f"r2 endpoint={manifest['r2']['endpoint_url']}")
            print(
                f"inventory namespace objects={manifest['inventory']['full_bucket']['object_count']} "
                f"bytes={manifest['inventory']['full_bucket']['total_bytes']}"
            )
            print(
                f"snapshot objects={len(manifest['inventory']['recovery_objects'])} "
                f"bytes={sum(item['size'] for item in manifest['inventory']['recovery_objects'])}"
            )
            print(
                "24h expiring projects="
                f"{len(manifest['scope_plan']['expiring_projects'])}"
            )
            print(
                "target student counts="
                f"{manifest['scope_plan']['target_student_counts']}"
            )
            print(
                "24h expiring detail="
                f"{manifest['scope_plan']['expiring_projects']}"
            )
            for scope in manifest["inventory"]["recovery_scopes"]:
                print(
                    f"recovery scope={scope['prefix']} "
                    f"objects={scope['object_count']} bytes={scope['total_bytes']}"
                )
            print(f"scope_sha256={manifest['scope_plan']['scope_sha256']}")
            print(
                "inventory_namespace_sha256="
                f"{manifest['inventory']['full_bucket']['ordered_key_size_etag_last_modified_sha256']}"
            )
            print(
                "outside_inventory_sha256="
                f"{manifest['inventory']['outside_recovery_scopes']['ordered_key_size_etag_last_modified_sha256']}"
            )
        elif args.command == "snapshot":
            manifest, artifact_path = create_snapshot(
                database_path=args.database,
                plan_path=args.reviewed_manifest,
                plan_sha256=args.reviewed_manifest_sha256,
                acknowledgement=args.acknowledge_project_ids,
                s3_client=s3_client,
                binding=binding,
            )
            print("R2 私有快照完成（零 R2 寫入）")
            print(
                f"objects={manifest['snapshot_object_count']} "
                f"bytes={manifest['snapshot_total_bytes']}"
            )
            print(
                "snapshot_content_contract_sha256="
                f"{manifest['snapshot_content_contract_sha256']}"
            )
        elif args.command == "audit-after":
            manifest, artifact_path = audit_after(
                snapshot_path=args.snapshot_manifest,
                snapshot_sha256=args.snapshot_manifest_sha256,
                s3_client=s3_client,
                binding=binding,
            )
            print("R2 post-change audit 通過")
            print(
                f"changed recovery scopes={manifest['changed_recovery_scope_count']}"
            )
        elif args.command == "verify-before-start":
            manifest, artifact_path = verify_before_start(
                database_path=args.database,
                snapshot_path=args.snapshot_manifest,
                snapshot_sha256=args.snapshot_manifest_sha256,
                s3_client=s3_client,
                binding=binding,
            )
            print("candidate 啟動前 freshness gate 通過")
            print(
                "covered 24h risk projects="
                f"{manifest['covered_24h_risk_project_count']}"
            )
        else:
            manifest, artifact_path = restore(
                database_path=args.database,
                snapshot_path=args.snapshot_manifest,
                snapshot_sha256=args.snapshot_manifest_sha256,
                acknowledgement=args.acknowledge_restore,
                apply_requested=args.apply,
                s3_client=s3_client,
                binding=binding,
            )
            print("R2 restore 完成" if args.apply else "R2 restore dry-run 完成")
            print(
                f"changed recovery scopes={manifest['changed_recovery_scope_count']}"
            )
        print(f"artifact={artifact_path}")
        print(f"artifact_sha256={_file_sha256(artifact_path)}")
        return 0
    except SnapshotPreflightError as error:
        print(f"preflight 失敗：{error}", file=sys.stderr)
        return 1
    except (
        OSError,
        sqlite3.DatabaseError,
        SnapshotConfigurationError,
        SnapshotOperationError,
    ) as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
