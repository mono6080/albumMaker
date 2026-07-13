import sqlite3
from datetime import datetime, timezone

import pytest

from scripts.backup_data import create_backup, restore_backup, verify_backup


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
