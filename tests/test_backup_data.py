import json
import sqlite3
import stat
from datetime import datetime, timezone

import pytest

import scripts.backup_data as backup_data
from scripts.backup_data import create_backup, restore_backup, verify_backup


def _create_crash_wal_snapshot(database_path):
    working_database = database_path.with_name(
        database_path.name + ".wal-source"
    )
    connection = sqlite3.connect(working_database)
    try:
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        connection.execute("PRAGMA wal_autocheckpoint=0")
        connection.execute("CREATE TABLE old_sample (value TEXT NOT NULL)")
        connection.execute("INSERT INTO old_sample VALUES ('checkpointed')")
        connection.commit()
        assert connection.execute(
            "PRAGMA wal_checkpoint(TRUNCATE)"
        ).fetchone() == (0, 0, 0)
        connection.execute("INSERT INTO old_sample VALUES ('committed-in-wal')")
        connection.commit()

        working_wal = working_database.with_name(working_database.name + "-wal")
        working_shm = working_database.with_name(working_database.name + "-shm")
        assert working_wal.stat().st_size > 0
        database_path.write_bytes(working_database.read_bytes())
        database_path.with_name(database_path.name + "-wal").write_bytes(
            working_wal.read_bytes()
        )
        database_path.with_name(database_path.name + "-shm").write_bytes(
            working_shm.read_bytes()
        )
    finally:
        connection.close()
        for suffix in ("", "-wal", "-shm"):
            working_database.with_name(
                working_database.name + suffix
            ).unlink(missing_ok=True)


def test_backup_verify_and_restore_roundtrip(tmp_path):
    database = tmp_path / "source.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
        connection.execute("INSERT INTO sample VALUES ('original')")
    uploads = tmp_path / "uploads"
    (uploads / "projects" / "proj1").mkdir(parents=True)
    (uploads / "projects" / "proj1" / "photo.jpg").write_bytes(b"image-data")

    backup = create_backup(
        source_database=database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
        now=datetime(2026, 7, 13, tzinfo=timezone.utc),
    )
    manifest = verify_backup(backup)
    assert manifest["upload_file_count"] == 1

    restored_database = tmp_path / "restored.db"
    restored_uploads = tmp_path / "restored-uploads"
    restore_backup(
        backup,
        destination_database=restored_database,
        destination_uploads=restored_uploads,
        confirm_replace=True,
    )
    with sqlite3.connect(restored_database) as connection:
        assert connection.execute("SELECT value FROM sample").fetchone()[0] == "original"
    assert (restored_uploads / "projects" / "proj1" / "photo.jpg").read_bytes() == b"image-data"


def test_backup_verification_detects_tampering_and_restore_requires_confirmation(tmp_path):
    database = tmp_path / "source.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(source_database=database, uploads_dir=uploads, output_dir=tmp_path / "backups")

    with pytest.raises(ValueError, match="confirm-replace"):
        restore_backup(backup, destination_database=tmp_path / "restored.db")
    with (backup / "database.sqlite3").open("ab") as output:
        output.write(b"tampered")
    with pytest.raises(ValueError, match="校驗失敗"):
        verify_backup(backup)


def test_backup_verification_rejects_foreign_key_violation_after_checksum_passes(tmp_path):
    database = tmp_path / "source.db"
    with sqlite3.connect(database) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        connection.execute(
            "CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent(id))"
        )
        connection.execute("INSERT INTO parent VALUES (1)")
        connection.execute("INSERT INTO child VALUES (1)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )

    database_artifact = backup / "database.sqlite3"
    with sqlite3.connect(database_artifact) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("DELETE FROM parent")
    manifest_path = backup / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"]["database"].update({
        "bytes": database_artifact.stat().st_size,
        "sha256": backup_data.sha256(database_artifact),
    })
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="備份外鍵檢查失敗"):
        verify_backup(backup)


def test_r2_manifest_does_not_claim_local_media_is_backed_up(tmp_path):
    database = tmp_path / "source.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT)")
    backup = create_backup(
        source_database=database,
        uploads_dir=tmp_path / "missing-uploads",
        output_dir=tmp_path / "backups",
        storage_backend="r2",
    )
    manifest = verify_backup(backup)
    assert "uploads" not in manifest["files"]
    assert "R2" in manifest["note"]


def test_verify_uses_immutable_read_without_creating_sidecars(
    tmp_path,
    monkeypatch,
):
    database = tmp_path / "source.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    database_artifact = (backup / "database.sqlite3").resolve()
    sidecar_paths = [
        database_artifact.with_name(database_artifact.name + suffix)
        for suffix in ("-wal", "-shm")
    ]
    assert not any(path.exists() for path in sidecar_paths)

    original_connect = sqlite3.connect
    observed_connections = []

    def recording_connect(database_url, *args, **kwargs):
        observed_connections.append((str(database_url), kwargs.copy()))
        return original_connect(database_url, *args, **kwargs)

    monkeypatch.setattr(backup_data.sqlite3, "connect", recording_connect)
    verify_backup(backup)

    assert observed_connections == [
        (
            f"{database_artifact.as_uri()}?mode=ro&immutable=1",
            {"uri": True},
        )
    ]
    assert not any(path.exists() for path in sidecar_paths)


@pytest.mark.parametrize("sidecar_suffix", ["-wal", "-shm", "-journal"])
def test_verify_rejects_database_sidecars(tmp_path, sidecar_suffix):
    database = tmp_path / "source.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    database_artifact = backup / "database.sqlite3"
    database_artifact.with_name(
        database_artifact.name + sidecar_suffix
    ).write_bytes(b"unverified sidecar")

    with pytest.raises(ValueError, match="未列入 manifest"):
        verify_backup(backup)


def test_create_backup_from_wal_database_remains_self_contained(tmp_path):
    database = tmp_path / "source.db"
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    with sqlite3.connect(database) as connection:
        assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        connection.execute("CREATE TABLE sample (value TEXT)")
        connection.execute("INSERT INTO sample VALUES ('latest')")
        connection.commit()
        backup = create_backup(
            source_database=database,
            uploads_dir=uploads,
            output_dir=tmp_path / "backups",
        )

    database_artifact = backup / "database.sqlite3"
    assert not database_artifact.with_name(
        database_artifact.name + "-wal"
    ).exists()
    assert not database_artifact.with_name(
        database_artifact.name + "-shm"
    ).exists()
    verify_backup(backup)


def test_restore_checkpoint_sidecar_fsync_replace_order(tmp_path, monkeypatch):
    source_database = tmp_path / "source.db"
    with sqlite3.connect(source_database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
        connection.execute("INSERT INTO sample VALUES ('restored')")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=source_database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )

    destination_database = tmp_path / "destination.db"
    with sqlite3.connect(destination_database) as connection:
        connection.execute("CREATE TABLE old_sample (value TEXT NOT NULL)")
        connection.execute("INSERT INTO old_sample VALUES ('old')")
    connection.close()
    stale_wal = tmp_path / "destination.db-wal"
    stale_shm = tmp_path / "destination.db-shm"
    stale_journal = tmp_path / "destination.db-journal"
    stale_wal.write_bytes(b"stale wal")
    stale_shm.write_bytes(b"stale shm")
    stale_journal.write_bytes(b"stale journal")
    events = []
    real_verify_restored = backup_data._verify_restored_database
    real_checkpoint = backup_data._checkpoint_existing_database
    real_remove_sidecars = backup_data._remove_sqlite_sidecars
    real_replace = backup_data.os.replace

    def record_verify_restored(database_path):
        events.append(("verify", database_path))
        real_verify_restored(database_path)

    def record_checkpoint(database_path):
        events.append(("checkpoint", database_path))
        real_checkpoint(database_path)

    def record_remove_sidecars(database_path):
        events.append(("remove_sidecars", database_path))
        real_remove_sidecars(database_path)

    def record_parent_fsync(directory_path):
        events.append(("fsync_parent", directory_path))

    def record_replace(source_path, destination_path):
        events.append(("replace", destination_path))
        assert not stale_wal.exists()
        assert not stale_shm.exists()
        assert not stale_journal.exists()
        connection = sqlite3.connect(destination_database)
        try:
            assert connection.execute(
                "SELECT value FROM old_sample"
            ).fetchone()[0] == "old"
        finally:
            connection.close()
        real_replace(source_path, destination_path)

    monkeypatch.setattr(
        backup_data,
        "_verify_restored_database",
        record_verify_restored,
    )
    monkeypatch.setattr(
        backup_data,
        "_checkpoint_existing_database",
        record_checkpoint,
    )
    monkeypatch.setattr(
        backup_data,
        "_remove_sqlite_sidecars",
        record_remove_sidecars,
    )
    monkeypatch.setattr(
        backup_data,
        "_fsync_parent_directory",
        record_parent_fsync,
    )
    monkeypatch.setattr(backup_data.os, "replace", record_replace)

    restore_backup(backup, destination_database=destination_database, confirm_replace=True)

    assert events[0][0] == "verify"
    assert events[0][1] != destination_database
    assert events[1:] == [
        ("checkpoint", destination_database),
        ("remove_sidecars", destination_database),
        ("fsync_parent", tmp_path),
        ("replace", destination_database),
        ("fsync_parent", tmp_path),
        ("verify", destination_database),
    ]
    assert not stale_wal.exists()
    assert not stale_shm.exists()
    assert not stale_journal.exists()
    with sqlite3.connect(destination_database) as connection:
        assert connection.execute("SELECT value FROM sample").fetchone()[0] == "restored"
    connection.close()


def test_restore_checkpoints_real_committed_wal_before_replace(
    tmp_path,
    monkeypatch,
):
    source_database = tmp_path / "source.db"
    with sqlite3.connect(source_database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
        connection.execute("INSERT INTO sample VALUES ('restored')")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=source_database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    destination_database = tmp_path / "destination.db"
    _create_crash_wal_snapshot(destination_database)
    destination_wal = tmp_path / "destination.db-wal"
    destination_shm = tmp_path / "destination.db-shm"
    assert destination_wal.stat().st_size > 0
    real_replace = backup_data.os.replace

    def inspect_old_database_before_replace(source_path, destination_path):
        assert not destination_wal.exists()
        assert not destination_shm.exists()
        connection = sqlite3.connect(
            f"{destination_database.resolve().as_uri()}?mode=ro&immutable=1",
            uri=True,
        )
        try:
            assert connection.execute(
                "SELECT value FROM old_sample ORDER BY rowid"
            ).fetchall() == [("checkpointed",), ("committed-in-wal",)]
        finally:
            connection.close()
        real_replace(source_path, destination_path)

    monkeypatch.setattr(
        backup_data.os,
        "replace",
        inspect_old_database_before_replace,
    )

    restore_backup(
        backup,
        destination_database=destination_database,
        confirm_replace=True,
    )

    with sqlite3.connect(destination_database) as connection:
        assert connection.execute("SELECT value FROM sample").fetchone()[0] == "restored"


def test_restore_replace_failure_keeps_checkpointed_wal_data_openable(
    tmp_path,
    monkeypatch,
):
    source_database = tmp_path / "source.db"
    with sqlite3.connect(source_database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=source_database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    destination_database = tmp_path / "destination.db"
    _create_crash_wal_snapshot(destination_database)
    destination_wal = tmp_path / "destination.db-wal"
    destination_shm = tmp_path / "destination.db-shm"

    def fail_replace(source_path, destination_path):
        raise OSError("replace failed after checkpoint")

    monkeypatch.setattr(backup_data.os, "replace", fail_replace)

    with pytest.raises(OSError, match="replace failed after checkpoint"):
        restore_backup(
            backup,
            destination_database=destination_database,
            confirm_replace=True,
        )

    assert not destination_wal.exists()
    assert not destination_shm.exists()
    connection = sqlite3.connect(
        f"{destination_database.resolve().as_uri()}?mode=ro&immutable=1",
        uri=True,
    )
    try:
        assert connection.execute(
            "SELECT value FROM old_sample ORDER BY rowid"
        ).fetchall() == [("checkpointed",), ("committed-in-wal",)]
    finally:
        connection.close()
    assert list(tmp_path.glob(".destination.db.restore-*.tmp")) == []


def test_restore_busy_wal_checkpoint_does_not_unlink_or_replace(
    tmp_path,
    monkeypatch,
):
    source_database = tmp_path / "source.db"
    with sqlite3.connect(source_database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=source_database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    destination_database = tmp_path / "destination.db"
    writer = sqlite3.connect(destination_database, timeout=0)
    reader = None
    try:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE old_sample (value TEXT NOT NULL)")
        writer.execute("INSERT INTO old_sample VALUES ('reader-snapshot')")
        writer.commit()
        assert writer.execute(
            "PRAGMA wal_checkpoint(TRUNCATE)"
        ).fetchone() == (0, 0, 0)

        reader = sqlite3.connect(destination_database, timeout=0)
        reader.execute("BEGIN")
        assert reader.execute("SELECT value FROM old_sample").fetchall() == [
            ("reader-snapshot",)
        ]
        writer.execute("INSERT INTO old_sample VALUES ('committed-after-reader')")
        writer.commit()
        destination_wal = tmp_path / "destination.db-wal"
        destination_shm = tmp_path / "destination.db-shm"
        before_files = {
            path: path.read_bytes()
            for path in (destination_database, destination_wal, destination_shm)
        }
        sidecars_removed = False
        replace_called = False

        def reject_sidecar_removal(database_path):
            nonlocal sidecars_removed
            sidecars_removed = True

        def reject_replace(source_path, destination_path):
            nonlocal replace_called
            replace_called = True

        monkeypatch.setattr(
            backup_data,
            "_remove_sqlite_sidecars",
            reject_sidecar_removal,
        )
        monkeypatch.setattr(backup_data.os, "replace", reject_replace)

        with pytest.raises(RuntimeError, match="busy connection"):
            restore_backup(
                backup,
                destination_database=destination_database,
                confirm_replace=True,
            )

        assert not sidecars_removed
        assert not replace_called
        assert {
            path: path.read_bytes()
            for path in (destination_database, destination_wal)
        } == {
            path: before_files[path]
            for path in (destination_database, destination_wal)
        }
        assert destination_shm.exists()
        assert writer.execute(
            "SELECT value FROM old_sample ORDER BY rowid"
        ).fetchall() == [
            ("reader-snapshot",),
            ("committed-after-reader",),
        ]
        assert list(tmp_path.glob(".destination.db.restore-*.tmp")) == []
    finally:
        if reader is not None:
            reader.rollback()
            reader.close()
        writer.close()


def test_restore_preserves_existing_database_mode(tmp_path):
    source_database = tmp_path / "source.db"
    with sqlite3.connect(source_database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=source_database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    destination_database = tmp_path / "destination.db"
    with sqlite3.connect(destination_database) as connection:
        connection.execute("CREATE TABLE old_sample (value TEXT NOT NULL)")
        connection.execute("INSERT INTO old_sample VALUES ('old')")
    connection.close()
    destination_database.chmod(0o640)
    original_mode = stat.S_IMODE(destination_database.stat().st_mode)

    restore_backup(backup, destination_database=destination_database, confirm_replace=True)

    assert stat.S_IMODE(destination_database.stat().st_mode) == original_mode


def test_restore_copy_failure_preserves_existing_database_and_cleans_temporary_file(tmp_path, monkeypatch):
    source_database = tmp_path / "source.db"
    with sqlite3.connect(source_database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=source_database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    destination_database = tmp_path / "destination.db"
    destination_database.write_bytes(b"original database bytes")

    def fail_during_copy(source, destination, length=0):
        destination.write(b"partial replacement")
        raise OSError("copy failed")

    monkeypatch.setattr(backup_data.shutil, "copyfileobj", fail_during_copy)

    with pytest.raises(OSError, match="copy failed"):
        restore_backup(backup, destination_database=destination_database, confirm_replace=True)

    assert destination_database.read_bytes() == b"original database bytes"
    assert list(tmp_path.glob(".destination.db.restore-*.tmp")) == []


def test_restore_replace_failure_preserves_existing_database_and_cleans_temporary_file(tmp_path, monkeypatch):
    source_database = tmp_path / "source.db"
    with sqlite3.connect(source_database) as connection:
        connection.execute("CREATE TABLE sample (value TEXT NOT NULL)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=source_database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    destination_database = tmp_path / "destination.db"
    with sqlite3.connect(destination_database) as connection:
        connection.execute("CREATE TABLE old_sample (value TEXT NOT NULL)")
        connection.execute("INSERT INTO old_sample VALUES ('old')")
    connection.close()

    def fail_replace(source, destination):
        raise OSError("replace failed")

    monkeypatch.setattr(backup_data.os, "replace", fail_replace)

    with pytest.raises(OSError, match="replace failed"):
        restore_backup(backup, destination_database=destination_database, confirm_replace=True)

    with sqlite3.connect(destination_database) as connection:
        assert connection.execute(
            "SELECT value FROM old_sample"
        ).fetchone()[0] == "old"
    connection.close()
    assert list(tmp_path.glob(".destination.db.restore-*.tmp")) == []


def test_restore_rejects_foreign_key_violation_before_replacing_database(tmp_path):
    source_database = tmp_path / "source.db"
    with sqlite3.connect(source_database) as connection:
        connection.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        connection.execute(
            "CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent(id))"
        )
        connection.execute("INSERT INTO parent VALUES (999)")
        connection.execute("INSERT INTO child VALUES (999)")
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    backup = create_backup(
        source_database=source_database,
        uploads_dir=uploads,
        output_dir=tmp_path / "backups",
    )
    database_artifact = backup / "database.sqlite3"
    with sqlite3.connect(database_artifact) as connection:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("DELETE FROM parent")
    manifest_path = backup / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"]["database"].update({
        "bytes": database_artifact.stat().st_size,
        "sha256": backup_data.sha256(database_artifact),
    })
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    destination_database = tmp_path / "destination.db"
    destination_database.write_bytes(b"original database bytes")

    with pytest.raises(ValueError, match="備份外鍵檢查失敗"):
        restore_backup(backup, destination_database=destination_database, confirm_replace=True)

    assert destination_database.read_bytes() == b"original database bytes"
    assert list(tmp_path.glob(".destination.db.restore-*.tmp")) == []
