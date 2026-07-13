"""建立、驗證與還原 Album Maker 的 SQLite／本機媒體備份。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = ROOT_DIR / "backend" / "album_maker.db"
DEFAULT_UPLOADS = ROOT_DIR / "backend" / "uploads"
DEFAULT_OUTPUT = ROOT_DIR / "backups"
BACKUP_PREFIX = "album-maker-backup-"


def database_path(database_url: str | None = None) -> Path:
    raw_url = database_url or os.getenv("DATABASE_URL")
    if not raw_url:
        return DEFAULT_DATABASE.resolve()
    if not raw_url.startswith("sqlite:///"):
        raise ValueError("備份工具目前只支援 sqlite:/// DATABASE_URL")
    raw_path = raw_url.removeprefix("sqlite:///")
    if not raw_path or raw_path == ":memory:":
        raise ValueError("無法備份記憶體 SQLite 資料庫")
    path = Path(raw_path)
    return (path if path.is_absolute() else Path.cwd() / path).resolve()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sqlite_backup(source_path: Path, destination_path: Path) -> None:
    if not source_path.is_file():
        raise FileNotFoundError(f"找不到 SQLite 資料庫：{source_path}")
    with sqlite3.connect(source_path) as source, sqlite3.connect(destination_path) as destination:
        source.backup(destination)
        result = destination.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            raise RuntimeError(f"SQLite 備份完整性檢查失敗：{result}")


def archive_uploads(source_dir: Path, destination_path: Path) -> int:
    if not source_dir.is_dir():
        raise FileNotFoundError(f"找不到媒體目錄：{source_dir}")
    count = 0
    with zipfile.ZipFile(destination_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source_dir.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(source_dir).as_posix())
                count += 1
    return count


def _artifact(path: Path) -> dict[str, str | int]:
    return {"filename": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)}


def prune_backups(output_dir: Path, keep_days: int, *, now: datetime | None = None) -> int:
    if keep_days < 1:
        raise ValueError("keep_days 必須至少為 1")
    cutoff = (now or datetime.now(timezone.utc)) - timedelta(days=keep_days)
    removed = 0
    for candidate in output_dir.glob(f"{BACKUP_PREFIX}*"):
        if not candidate.is_dir() or candidate.name.endswith(".tmp"):
            continue
        modified = datetime.fromtimestamp(candidate.stat().st_mtime, timezone.utc)
        if modified < cutoff:
            shutil.rmtree(candidate)
            removed += 1
    return removed


def create_backup(
    *,
    source_database: Path,
    uploads_dir: Path,
    output_dir: Path,
    storage_backend: str = "local",
    keep_days: int | None = None,
    now: datetime | None = None,
) -> Path:
    output_dir = output_dir.resolve()
    uploads_dir = uploads_dir.resolve()
    if output_dir == uploads_dir or uploads_dir in output_dir.parents:
        raise ValueError("備份輸出目錄不可放在 uploads 內，以免遞迴封裝")
    output_dir.mkdir(parents=True, exist_ok=True)
    created_at = now or datetime.now(timezone.utc)
    name = f"{BACKUP_PREFIX}{created_at.strftime('%Y%m%dT%H%M%SZ')}"
    final_dir = output_dir / name
    if final_dir.exists():
        raise FileExistsError(f"備份目錄已存在：{final_dir}")

    # manifest 最後才寫入；沒有 manifest 的目錄永遠不會通過 verify。
    final_dir.mkdir()
    try:
        database_artifact = final_dir / "database.sqlite3"
        sqlite_backup(source_database.resolve(), database_artifact)
        files = {"database": _artifact(database_artifact)}
        upload_count = 0
        normalized_backend = storage_backend.strip().lower()
        if normalized_backend == "local":
            uploads_artifact = final_dir / "uploads.zip"
            upload_count = archive_uploads(uploads_dir, uploads_artifact)
            files["uploads"] = _artifact(uploads_artifact)

        manifest = {
            "format_version": 1,
            "created_at": created_at.isoformat(),
            "storage_backend": normalized_backend,
            "upload_file_count": upload_count,
            "files": files,
            "note": (
                "R2 物件未包含；請另行啟用 bucket versioning／複寫。"
                if normalized_backend != "local"
                else "SQLite 與本機媒體均已包含。"
            ),
        }
        (final_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except Exception:
        shutil.rmtree(final_dir, ignore_errors=True)
        raise

    verify_backup(final_dir)
    if keep_days is not None:
        prune_backups(output_dir, keep_days, now=created_at)
    return final_dir


def verify_backup(backup_dir: Path) -> dict:
    backup_dir = backup_dir.resolve()
    manifest_path = backup_dir / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"找不到 manifest：{manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format_version") != 1 or not isinstance(manifest.get("files"), dict):
        raise ValueError("不支援或損壞的備份 manifest")
    for artifact in manifest["files"].values():
        path = backup_dir / artifact["filename"]
        if not path.is_file() or path.stat().st_size != artifact["bytes"] or sha256(path) != artifact["sha256"]:
            raise ValueError(f"備份校驗失敗：{path.name}")
    with sqlite3.connect(backup_dir / manifest["files"]["database"]["filename"]) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            raise ValueError(f"SQLite 備份完整性檢查失敗：{result}")
    return manifest


def _safe_extract(archive_path: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            relative = Path(member.filename)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError(f"媒體備份含不安全路徑：{member.filename}")
        archive.extractall(destination)


def restore_backup(
    backup_dir: Path,
    *,
    destination_database: Path,
    destination_uploads: Path | None = None,
    confirm_replace: bool = False,
) -> None:
    if not confirm_replace:
        raise ValueError("還原會取代現有資料；必須明確指定 --confirm-replace")
    manifest = verify_backup(backup_dir)
    backup_dir = backup_dir.resolve()
    destination_database = destination_database.resolve()
    destination_database.parent.mkdir(parents=True, exist_ok=True)
    database_source = backup_dir / manifest["files"]["database"]["filename"]
    shutil.copy2(database_source, destination_database)

    uploads_artifact = manifest["files"].get("uploads")
    if uploads_artifact and destination_uploads is not None:
        destination_uploads = destination_uploads.resolve()
        staging = destination_uploads.with_name(destination_uploads.name + ".restore-tmp")
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        _safe_extract(backup_dir / uploads_artifact["filename"], staging)
        if destination_uploads.exists():
            shutil.rmtree(destination_uploads)
        try:
            shutil.copytree(staging, destination_uploads)
        finally:
            shutil.rmtree(staging, ignore_errors=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create", help="建立並立即驗證備份")
    create.add_argument("--database-url", default=None)
    create.add_argument("--uploads-dir", type=Path, default=Path(os.getenv("ALBUM_MAKER_UPLOADS_DIR", DEFAULT_UPLOADS)))
    create.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    create.add_argument("--storage-backend", default=os.getenv("STORAGE_BACKEND", "local"))
    create.add_argument("--keep-days", type=int, default=None)
    verify = subparsers.add_parser("verify", help="驗證 checksum 與 SQLite 完整性")
    verify.add_argument("backup_dir", type=Path)
    restore = subparsers.add_parser("restore", help="還原已驗證的備份（應先停止應用程式）")
    restore.add_argument("backup_dir", type=Path)
    restore.add_argument("--database-destination", type=Path, required=True)
    restore.add_argument("--uploads-destination", type=Path)
    restore.add_argument("--confirm-replace", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "create":
            result = create_backup(
                source_database=database_path(args.database_url), uploads_dir=args.uploads_dir,
                output_dir=args.output_dir, storage_backend=args.storage_backend, keep_days=args.keep_days,
            )
            print(result)
        elif args.command == "verify":
            verify_backup(args.backup_dir)
            print(f"備份驗證通過：{args.backup_dir.resolve()}")
        else:
            restore_backup(
                args.backup_dir, destination_database=args.database_destination,
                destination_uploads=args.uploads_destination, confirm_replace=args.confirm_replace,
            )
            print("備份還原完成")
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError, sqlite3.DatabaseError) as exc:
        print(f"錯誤：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
