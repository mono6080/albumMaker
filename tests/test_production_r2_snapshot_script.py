from __future__ import annotations

import hashlib
import io
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from scripts import snapshot_production_r2_outputs_202607 as snapshot_script


class FakePaginator:
    def __init__(self, client: FakeS3Client):
        self.client = client

    def paginate(self, **parameters):
        prefix = parameters.get("Prefix", "")
        contents = [
            {
                "Key": key,
                "Size": len(data),
                "ETag": f'"{hashlib.md5(data).hexdigest()}"',  # noqa: S324
                "LastModified": self.client.last_modified.setdefault(
                    key, datetime(2026, 7, 18, tzinfo=timezone.utc)
                ),
            }
            for key, data in sorted(self.client.objects.items())
            if key.startswith(prefix)
        ]
        yield {"Contents": contents}


class FakeS3Client:
    def __init__(self, objects: dict[str, bytes]):
        self.objects = dict(objects)
        baseline_time = datetime(2026, 7, 18, tzinfo=timezone.utc)
        self.last_modified = {key: baseline_time for key in objects}
        self.headers = {
            key: {
                "ContentType": "application/octet-stream",
                "Metadata": {"fixture": "yes"},
            }
            for key in objects
        }
        self.deleted_batches: list[list[str]] = []
        self.put_keys: list[str] = []
        self.corrupt_metadata_after_put = False
        self.delete_partial_once = False
        self.put_fail_once = False

    def get_paginator(self, operation_name: str):
        assert operation_name == "list_objects_v2"
        return FakePaginator(self)

    def get_object(self, *, Bucket: str, Key: str):
        assert Bucket == "production-bucket"
        data = self.objects[Key]
        response = {
            "Body": io.BytesIO(data),
            "ContentLength": len(data),
            "ETag": f'"{hashlib.md5(data).hexdigest()}"',  # noqa: S324
        }
        response.update(self.headers[Key])
        if self.corrupt_metadata_after_put and Key in self.put_keys:
            response["Metadata"] = {"fixture": "corrupt"}
        return response

    def head_object(self, *, Bucket: str, Key: str):
        response = self.get_object(Bucket=Bucket, Key=Key)
        response.pop("Body")
        return response

    def put_object(self, *, Bucket: str, Key: str, Body, **headers):
        assert Bucket == "production-bucket"
        if self.put_fail_once:
            self.put_fail_once = False
            raise OSError("injected put failure")
        self.objects[Key] = Body.read()
        self.headers[Key] = headers
        self.last_modified[Key] = datetime.now(timezone.utc)
        self.put_keys.append(Key)
        return {"ETag": f'"{hashlib.md5(self.objects[Key]).hexdigest()}"'}  # noqa: S324

    def delete_objects(self, *, Bucket: str, Delete: dict):
        assert Bucket == "production-bucket"
        keys = [item["Key"] for item in Delete["Objects"]]
        if self.delete_partial_once and keys:
            self.delete_partial_once = False
            deleted_key = keys[0]
            self.objects.pop(deleted_key, None)
            self.headers.pop(deleted_key, None)
            self.last_modified.pop(deleted_key, None)
            return {"Errors": [{"Key": key, "Code": "Injected"} for key in keys[1:] or keys]}
        self.deleted_batches.append(keys)
        for key in keys:
            self.objects.pop(key, None)
            self.headers.pop(key, None)
            self.last_modified.pop(key, None)
        return {"Deleted": [{"Key": key} for key in keys]}


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _make_database(
    path: Path,
    *,
    now: datetime,
    include_expired: bool = False,
) -> None:
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                deleted_at TEXT,
                archive_expires_at TEXT
            );
            CREATE TABLE students (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL,
                output_filename TEXT
            );
            """
        )
        connection.executemany(
            "INSERT INTO projects (id, deleted_at, archive_expires_at) VALUES (?, ?, ?)",
            [
                (50, None, None),
                (174, None, None),
                (106, _timestamp(now - timedelta(days=1)), _timestamp(now + timedelta(hours=12))),
                (107, _timestamp(now - timedelta(days=1)), _timestamp(now + timedelta(hours=30))),
            ],
        )
        if include_expired:
            connection.execute(
                "INSERT INTO projects (id, deleted_at, archive_expires_at) VALUES (?, ?, ?)",
                (
                    199,
                    _timestamp(now - timedelta(days=2)),
                    _timestamp(now - timedelta(minutes=1)),
                ),
            )
        connection.executemany(
            "INSERT INTO students (id, project_id, output_filename) VALUES (?, ?, ?)",
            [
                (501, 50, None),
                (502, 50, "projects/proj50/output/班級-小明.pdf"),
                (1741, 174, None),
            ],
        )


def _initial_objects() -> dict[str, bytes]:
    return {
        "templates/tmpl1/background.jpg": b"outside",
        "projects/proj50/output-old/sibling.pdf": b"sibling",
        "projects/proj1060/sibling.jpg": b"sibling-project",
        "projects/proj50/output/班級-小明.pdf": b"legacy-print",
        "projects/proj50/output/班級-小明_screen.pdf": b"legacy-screen",
        "projects/proj50/output/班級-小明/page1.jpg": b"legacy-page",
        "projects/proj50/output/preserved-flat.pdf": b"preserved-flat",
        "projects/proj106/photos/archive.jpg": b"expiring-project",
    }


@pytest.fixture
def prepared(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # 正式 CLI 強制 repo 外；測試以假的 repo root 保留同一驗證路徑。
    monkeypatch.setattr(snapshot_script, "ROOT_DIR", tmp_path / "fake-repository")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    database_path = tmp_path / "production.db"
    _make_database(database_path, now=now)
    snapshot_dir = tmp_path / "private" / "cutover-1"
    client = FakeS3Client(_initial_objects())
    p50_objects = {
        key: data
        for key, data in client.objects.items()
        if key.startswith("projects/proj50/output/")
    }
    monkeypatch.setattr(
        snapshot_script,
        "EXPECTED_TARGET_OUTPUT_BASELINE",
        {50: (len(p50_objects), sum(map(len, p50_objects.values()))), 174: (0, 0)},
    )
    binding = snapshot_script.R2Binding(
        "production-bucket",
        "",
        "account-a",
        "https://account-a.r2.cloudflarestorage.com",
    )
    return now, database_path, snapshot_dir, client, binding


def _create_plan_and_snapshot(prepared):
    now, database_path, snapshot_dir, client, binding = prepared
    plan, plan_path = snapshot_script.create_plan(
        database_path=database_path,
        snapshot_dir=snapshot_dir,
        cutover_id="cutover-1",
        s3_client=client,
        binding=binding,
        observed_at=now,
    )
    plan_sha256 = snapshot_script._file_sha256(plan_path)
    snapshot, snapshot_path = snapshot_script.create_snapshot(
        database_path=database_path,
        plan_path=plan_path,
        plan_sha256=plan_sha256,
        acknowledgement="50,174",
        s3_client=client,
        binding=binding,
    )
    return plan, plan_path, snapshot, snapshot_path


def test_plan_includes_full_outputs_precise_mutable_scopes_and_expiring_project(
    prepared,
):
    now, database_path, snapshot_dir, client, binding = prepared
    plan, plan_path = snapshot_script.create_plan(
        database_path=database_path,
        snapshot_dir=snapshot_dir,
        cutover_id="cutover-1",
        s3_client=client,
        binding=binding,
        observed_at=now,
    )

    scope = plan["scope_plan"]
    assert scope["recovery_prefixes"] == [
        "projects/proj106",
        "projects/proj174/output",
        "projects/proj50/output",
    ]
    assert "projects/proj50/output/students/student501" in scope["mutable_prefixes"]
    assert "projects/proj50/output/班級-小明" in scope["mutable_prefixes"]
    assert scope["mutable_exact_keys"] == [
        "projects/proj50/output/班級-小明.pdf",
        "projects/proj50/output/班級-小明_screen.pdf",
    ]
    assert scope["expiring_projects"] == [
        {
            "project_id": 106,
            "archive_expires_at": _timestamp(now + timedelta(hours=12)),
        }
    ]
    assert plan["inventory"]["full_bucket"]["object_count"] == 8
    assert plan["inventory"]["outside_recovery_scopes"]["object_count"] == 3
    assert plan["inventory"]["immutable_within_recovery_scopes"]["object_count"] == 1
    assert "班級-小明" in plan_path.read_text(encoding="utf-8")
    assert plan_path.stat().st_mode & 0o777 in {0o600, 0o666}


def test_plan_rejects_existing_expired_archived_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(snapshot_script, "ROOT_DIR", tmp_path / "fake-repository")
    now = datetime.now(timezone.utc).replace(microsecond=0)
    database_path = tmp_path / "production.db"
    _make_database(database_path, now=now, include_expired=True)

    with pytest.raises(
        snapshot_script.SnapshotPreflightError,
        match="已有到期",
    ):
        snapshot_script.create_plan(
            database_path=database_path,
            snapshot_dir=tmp_path / "private",
            cutover_id="cutover-1",
            s3_client=FakeS3Client(_initial_objects()),
            binding=snapshot_script.R2Binding(
                "production-bucket",
                "",
                "account-a",
                "https://account-a.r2.cloudflarestorage.com",
            ),
            observed_at=now,
        )


def test_snapshot_requires_reviewed_hash_and_rejects_bucket_drift(prepared):
    now, database_path, snapshot_dir, client, binding = prepared
    _plan, plan_path = snapshot_script.create_plan(
        database_path=database_path,
        snapshot_dir=snapshot_dir,
        cutover_id="cutover-1",
        s3_client=client,
        binding=binding,
        observed_at=now,
    )

    with pytest.raises(snapshot_script.SnapshotConfigurationError, match="SHA-256"):
        snapshot_script.create_snapshot(
            database_path=database_path,
            plan_path=plan_path,
            plan_sha256="0" * 64,
            acknowledgement="50,174",
            s3_client=client,
            binding=binding,
        )

    client.objects["templates/tmpl1/new.jpg"] = b"drift"
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="inventory"):
        snapshot_script.create_snapshot(
            database_path=database_path,
            plan_path=plan_path,
            plan_sha256=snapshot_script._file_sha256(plan_path),
            acknowledgement="50,174",
            s3_client=client,
            binding=binding,
        )


def test_snapshot_streams_content_addressed_blobs_and_pins_database(prepared):
    plan, _plan_path, snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    _now, database_path, _snapshot_dir, _client, _binding = prepared

    assert snapshot["snapshot_object_count"] == 5
    assert snapshot["snapshot_total_bytes"] == sum(
        item["size"] for item in plan["inventory"]["recovery_objects"]
    )
    for item in snapshot["objects"]:
        blob_path = snapshot_path.parent / item["blob"]
        assert blob_path.read_bytes() in _initial_objects().values()
        assert hashlib.sha256(blob_path.read_bytes()).hexdigest() == item["content_sha256"]

    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """UPDATE students SET output_filename = ? WHERE id = 501""",
            ("projects/proj50/output/students/student501/pdf/print.pdf",),
        )
    dry_run, _report_path = snapshot_script.restore(
        database_path=database_path,
        snapshot_path=snapshot_path,
        snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
        acknowledgement=None,
        apply_requested=False,
        s3_client=prepared[3],
        binding=prepared[4],
    )
    assert dry_run["overall_status"] == "dry_run"

    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "INSERT INTO students (id, project_id, output_filename) VALUES (999, 50, NULL)"
        )
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="Student"):
        snapshot_script.restore(
            database_path=database_path,
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
            acknowledgement=None,
            apply_requested=False,
            s3_client=prepared[3],
            binding=prepared[4],
        )


def test_snapshot_rejects_same_bucket_in_different_account(prepared):
    now, database_path, snapshot_dir, client, binding = prepared
    _plan, plan_path = snapshot_script.create_plan(
        database_path=database_path,
        snapshot_dir=snapshot_dir,
        cutover_id="cutover-1",
        s3_client=client,
        binding=binding,
        observed_at=now,
    )
    wrong_account = snapshot_script.R2Binding(
        "production-bucket",
        "",
        "account-b",
        "https://account-b.r2.cloudflarestorage.com",
    )

    with pytest.raises(snapshot_script.SnapshotPreflightError, match="binding"):
        snapshot_script.create_snapshot(
            database_path=database_path,
            plan_path=plan_path,
            plan_sha256=snapshot_script._file_sha256(plan_path),
            acknowledgement="50,174",
            s3_client=client,
            binding=wrong_account,
        )


def test_audit_allows_canonical_additions_but_rejects_legacy_or_outside_drift(
    prepared,
):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    client = prepared[3]
    binding = prepared[4]
    snapshot_sha256 = snapshot_script._file_sha256(snapshot_path)
    client.objects[
        "projects/proj50/output/students/student501/pdf/print.pdf"
    ] = b"new-canonical"

    report, _report_path = snapshot_script.audit_after(
        snapshot_path=snapshot_path,
        snapshot_sha256=snapshot_sha256,
        s3_client=client,
        binding=binding,
    )
    assert report["status"] == "passed"
    assert report["changed_recovery_scope_count"] == 1

    client.headers["projects/proj50/output/preserved-flat.pdf"]["Metadata"] = {
        "fixture": "metadata-drift"
    }
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="非允許"):
        snapshot_script.audit_after(
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_sha256,
            s3_client=client,
            binding=binding,
        )
    client.headers["projects/proj50/output/preserved-flat.pdf"]["Metadata"] = {
        "fixture": "yes"
    }

    client.objects["projects/proj50/output/preserved-flat.pdf"] = b"legacy-drift"
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="非允許"):
        snapshot_script.audit_after(
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_sha256,
            s3_client=client,
            binding=binding,
        )

    client.objects["projects/proj50/output/preserved-flat.pdf"] = b"preserved-flat"
    client.objects["templates/tmpl1/new.jpg"] = b"outside-drift"
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="非允許"):
        snapshot_script.audit_after(
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_sha256,
            s3_client=client,
            binding=binding,
        )


def test_restore_dry_run_is_read_only_and_apply_restores_only_changed_scopes(
    prepared,
):
    _plan, _plan_path, snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    _now, database_path, _snapshot_dir, client, binding = prepared
    snapshot_sha256 = snapshot_script._file_sha256(snapshot_path)
    baseline = dict(client.objects)
    client.objects[
        "projects/proj50/output/students/student501/pdf/print.pdf"
    ] = b"new-canonical"
    client.objects["projects/proj174/output/unexpected.pdf"] = b"must-delete"
    client.headers["projects/proj174/output/unexpected.pdf"] = {
        "ContentType": "application/pdf",
        "Metadata": {},
    }
    client.objects["projects/proj50/output/班級-小明.pdf"] = b"changed"
    del client.objects["projects/proj106/photos/archive.jpg"]
    before_dry_run = dict(client.objects)

    dry_run, _dry_run_path = snapshot_script.restore(
        database_path=database_path,
        snapshot_path=snapshot_path,
        snapshot_sha256=snapshot_sha256,
        acknowledgement=None,
        apply_requested=False,
        s3_client=client,
        binding=binding,
    )
    assert dry_run["changed_recovery_scope_count"] == 3
    assert client.objects == before_dry_run
    assert not client.deleted_batches

    result, _result_path = snapshot_script.restore(
        database_path=database_path,
        snapshot_path=snapshot_path,
        snapshot_sha256=snapshot_sha256,
        acknowledgement="50,174:cutover-1",
        apply_requested=True,
        s3_client=client,
        binding=binding,
    )

    assert result["overall_status"] == "complete"
    assert result["uploaded_object_count"] == snapshot["snapshot_object_count"]
    assert result["verified_object_count"] == snapshot["snapshot_object_count"]
    assert client.objects == baseline
    deleted_keys = {key for batch in client.deleted_batches for key in batch}
    assert all(
            key.startswith("projects/proj50/output/")
            or key.startswith("projects/proj174/output/")
            or key.startswith("projects/proj106/")
        for key in deleted_keys
    )
    assert "templates/tmpl1/background.jpg" not in deleted_keys
    assert "projects/proj50/output-old/sibling.pdf" not in deleted_keys
    assert "projects/proj1060/sibling.jpg" not in deleted_keys


def test_restore_requires_exact_acknowledgement(prepared):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)

    with pytest.raises(snapshot_script.SnapshotConfigurationError, match="acknowledgement"):
        snapshot_script.restore(
            database_path=prepared[1],
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
            acknowledgement="50,174:wrong-cutover",
            apply_requested=True,
            s3_client=prepared[3],
            binding=prepared[4],
        )


def test_restore_rejects_remote_metadata_drift_after_upload(prepared):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    client = prepared[3]
    client.objects[
        "projects/proj50/output/students/student501/pdf/print.pdf"
    ] = b"new-canonical"
    client.headers[
        "projects/proj50/output/students/student501/pdf/print.pdf"
    ] = {"ContentType": "application/pdf", "Metadata": {}}
    client.corrupt_metadata_after_put = True

    with pytest.raises(snapshot_script.SnapshotOperationError, match="metadata"):
        snapshot_script.restore(
            database_path=prepared[1],
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
            acknowledgement="50,174:cutover-1",
            apply_requested=True,
            s3_client=client,
            binding=prepared[4],
        )


def test_plan_manifest_contains_no_outside_keys(prepared):
    now, database_path, snapshot_dir, client, binding = prepared
    plan, plan_path = snapshot_script.create_plan(
        database_path=database_path,
        snapshot_dir=snapshot_dir,
        cutover_id="cutover-1",
        s3_client=client,
        binding=binding,
        observed_at=now,
    )

    raw_manifest = json.loads(plan_path.read_text(encoding="utf-8"))
    assert raw_manifest == plan
    assert "templates/tmpl1/background.jpg" not in plan_path.read_text(
        encoding="utf-8"
    )
    assert plan["inventory"]["outside_recovery_scopes"]["object_count"] == 3


def test_snapshot_directory_lock_rejects_concurrent_operation(prepared):
    snapshot_dir = prepared[2]
    snapshot_dir.mkdir(parents=True)
    with snapshot_script._snapshot_directory_lock(snapshot_dir):
        with pytest.raises(snapshot_script.SnapshotPreflightError, match="操作執行中"):
            with snapshot_script._snapshot_directory_lock(snapshot_dir):
                pass


def test_verify_before_start_passes_fresh_baseline(prepared):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    report, report_path = snapshot_script.verify_before_start(
        database_path=prepared[1],
        snapshot_path=snapshot_path,
        snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
        s3_client=prepared[3],
        binding=prepared[4],
        observed_at=prepared[0],
    )
    assert report["overall_status"] == "passed"
    assert report["covered_24h_risk_project_count"] == 1
    assert report_path.is_file()


def test_verify_before_start_rejects_newly_entered_24h_risk(prepared):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="未覆蓋"):
        snapshot_script.verify_before_start(
            database_path=prepared[1],
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
            s3_client=prepared[3],
            binding=prepared[4],
            observed_at=prepared[0] + timedelta(hours=7),
        )


def test_verify_before_start_rejects_r2_drift(prepared):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    prepared[3].objects[
        "projects/proj50/output/students/student501/pdf/print.pdf"
    ] = b"drift"
    prepared[3].headers[
        "projects/proj50/output/students/student501/pdf/print.pdf"
    ] = {"ContentType": "application/pdf", "Metadata": {}}
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="R2 baseline"):
        snapshot_script.verify_before_start(
            database_path=prepared[1],
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
            s3_client=prepared[3],
            binding=prepared[4],
            observed_at=prepared[0],
        )


def test_verify_before_start_rejects_non_target_database_drift(prepared):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    with sqlite3.connect(prepared[1]) as connection:
        connection.execute(
            "INSERT INTO projects (id, deleted_at, archive_expires_at) VALUES (300, NULL, NULL)"
        )
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="database path"):
        snapshot_script.verify_before_start(
            database_path=prepared[1],
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
            s3_client=prepared[3],
            binding=prepared[4],
            observed_at=prepared[0],
        )


def test_audit_rejects_outside_same_bytes_last_modified_drift(prepared):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    outside_key = "templates/tmpl1/background.jpg"
    prepared[3].last_modified[outside_key] += timedelta(seconds=1)
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="非允許"):
        snapshot_script.audit_after(
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
            s3_client=prepared[3],
            binding=prepared[4],
        )


def test_plan_rejects_wrong_reviewed_target_baseline(prepared, monkeypatch):
    monkeypatch.setattr(
        snapshot_script,
        "EXPECTED_TARGET_OUTPUT_BASELINE",
        {50: (160, 53_361_440), 174: (0, 0)},
    )
    with pytest.raises(snapshot_script.SnapshotPreflightError, match="baseline"):
        snapshot_script.create_plan(
            database_path=prepared[1],
            snapshot_dir=prepared[2],
            cutover_id="wrong-bucket",
            s3_client=FakeS3Client({}),
            binding=prepared[4],
            observed_at=prepared[0],
        )


@pytest.mark.parametrize("failure_mode", ["delete", "put"])
def test_restore_can_retry_same_snapshot_after_partial_failure(prepared, failure_mode):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    client = prepared[3]
    added_key = "projects/proj50/output/students/student501/pdf/print.pdf"
    client.objects[added_key] = b"new"
    client.headers[added_key] = {"ContentType": "application/pdf", "Metadata": {}}
    client.last_modified[added_key] = datetime.now(timezone.utc)
    if failure_mode == "delete":
        client.delete_partial_once = True
    else:
        client.put_fail_once = True
    arguments = {
        "database_path": prepared[1],
        "snapshot_path": snapshot_path,
        "snapshot_sha256": snapshot_script._file_sha256(snapshot_path),
        "acknowledgement": "50,174:cutover-1",
        "apply_requested": True,
        "s3_client": client,
        "binding": prepared[4],
    }
    with pytest.raises(snapshot_script.SnapshotOperationError):
        snapshot_script.restore(**arguments)
    result, _report_path = snapshot_script.restore(**arguments)
    assert result["overall_status"] == "complete"
    assert added_key not in client.objects


def test_rehashed_manifest_cannot_expand_recovery_scope(prepared):
    _plan, _plan_path, _snapshot, snapshot_path = _create_plan_and_snapshot(prepared)
    manifest = json.loads(snapshot_path.read_text(encoding="utf-8"))
    manifest["scope_plan"]["recovery_prefixes"].append("projects/proj999")
    scope_without_hash = dict(manifest["scope_plan"])
    scope_without_hash.pop("scope_sha256")
    manifest["scope_plan"]["scope_sha256"] = snapshot_script._canonical_json_sha256(
        scope_without_hash
    )
    snapshot_script._write_private_manifest(snapshot_path, manifest)
    with pytest.raises(snapshot_script.SnapshotConfigurationError, match="recovery prefixes"):
        snapshot_script.audit_after(
            snapshot_path=snapshot_path,
            snapshot_sha256=snapshot_script._file_sha256(snapshot_path),
            s3_client=prepared[3],
            binding=prepared[4],
        )
