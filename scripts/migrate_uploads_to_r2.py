"""Copy local backend/uploads files to Cloudflare R2.

This is intentionally a copy migration: local files are kept as a rollback
source until the R2-backed app has been verified.
"""

from __future__ import annotations

import argparse
import mimetypes
import os
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_UPLOADS_DIR = ROOT_DIR / "backend" / "uploads"


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(name, value)


def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SystemExit(f"Missing required env var: {name}")
    return value


def make_s3_client():
    try:
        import boto3
        from botocore.config import Config
    except ImportError as exc:
        raise SystemExit("boto3 is required. Install backend requirements first.") from exc

    account_id = require_env("R2_ACCOUNT_ID")
    access_key_id = require_env("R2_ACCESS_KEY_ID")
    secret_access_key = require_env("R2_SECRET_ACCESS_KEY")
    endpoint_url = os.getenv("R2_ENDPOINT_URL") or f"https://{account_id}.r2.cloudflarestorage.com"

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name="auto",
        config=Config(retries={"max_attempts": 5, "mode": "standard"}),
    )


def iter_files(base_dir: Path):
    for path in sorted(base_dir.rglob("*")):
        if path.is_file():
            yield path


def object_size(s3_client, bucket: str, key: str) -> int | None:
    try:
        response = s3_client.head_object(Bucket=bucket, Key=key)
    except Exception as exc:
        error = getattr(exc, "response", {}).get("Error", {})
        status = getattr(exc, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
        if error.get("Code") in {"404", "NoSuchKey", "NotFound"} or status == 404:
            return None
        raise
    return int(response["ContentLength"])


def upload_file(s3_client, bucket: str, path: Path, key: str) -> None:
    content_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
    s3_client.upload_file(
        str(path),
        bucket,
        key,
        ExtraArgs={"ContentType": content_type},
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy local backend/uploads files to Cloudflare R2.")
    parser.add_argument("--env-file", type=Path, default=ROOT_DIR / ".env")
    parser.add_argument("--uploads-dir", type=Path, default=DEFAULT_UPLOADS_DIR)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--overwrite", action="store_true", help="Upload even when the remote object has the same size.")
    args = parser.parse_args()

    load_env_file(args.env_file)
    uploads_dir = args.uploads_dir.resolve()
    if not uploads_dir.exists():
        raise SystemExit(f"Uploads dir does not exist: {uploads_dir}")

    bucket = require_env("R2_BUCKET")
    files = list(iter_files(uploads_dir))
    total_bytes = sum(path.stat().st_size for path in files)
    print(f"Source: {uploads_dir}")
    print(f"Bucket: {bucket}")
    print(f"Files: {len(files)}")
    print(f"Bytes: {total_bytes}")

    if args.dry_run:
        for path in files[:10]:
            print(path.relative_to(uploads_dir).as_posix())
        if len(files) > 10:
            print(f"... {len(files) - 10} more")
        return 0

    s3_client = make_s3_client()
    uploaded = 0
    skipped = 0
    checked = 0
    failed: list[tuple[str, str]] = []

    for index, path in enumerate(files, start=1):
        key = path.relative_to(uploads_dir).as_posix()
        size = path.stat().st_size
        try:
            remote_size = None if args.overwrite else object_size(s3_client, bucket, key)
            if remote_size == size:
                skipped += 1
            else:
                upload_file(s3_client, bucket, path, key)
                uploaded += 1
        except Exception as exc:
            failed.append((key, str(exc)))

        checked += 1
        if checked % 25 == 0 or checked == len(files):
            print(f"Progress {index}/{len(files)} uploaded={uploaded} skipped={skipped} failed={len(failed)}")

    if failed:
        print("Failed objects:")
        for key, message in failed[:20]:
            print(f"- {key}: {message}")
        if len(failed) > 20:
            print(f"... {len(failed) - 20} more failures")
        return 1

    print(f"Done uploaded={uploaded} skipped={skipped} failed=0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
