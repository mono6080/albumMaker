"""唯讀核對資料腳本 manifest 與目前 SQLite 實際套用狀態。"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.data_script_utils import classify_template_apply_state, layout_sha256

DEFAULT_DATABASE = BACKEND_DIR / "album_maker.db"


def inspect_manifest(database_path: Path, manifest_path: Path) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    template_results = []
    with sqlite3.connect(
        f"file:{database_path.resolve().as_posix()}?mode=ro",
        uri=True,
    ) as connection:
        connection.row_factory = sqlite3.Row
        backup_rows = connection.execute(
            """SELECT template_page_id, layout_json
               FROM template_page_layout_migration_backups
               WHERE migration_name = ?
               ORDER BY template_page_id""",
            (manifest["backup_name"],),
        ).fetchall()
        for template_manifest in manifest.get("templates", []):
            template_id = template_manifest["template_id"]
            template_row = connection.execute(
                "SELECT revision FROM templates WHERE id = ?",
                (template_id,),
            ).fetchone()
            if template_row is None:
                template_results.append({
                    "template_id": template_id,
                    "manifest_status": template_manifest["status"],
                    "observed_state": "missing_template",
                    "current_revision": None,
                })
                continue
            page_rows = connection.execute(
                """SELECT id, layout_json
                   FROM template_pages
                   WHERE template_id = ?
                   ORDER BY page_number""",
                (template_id,),
            ).fetchall()
            current_page_ids = [row["id"] for row in page_rows]
            current_layouts = {
                row["id"]: json.loads(row["layout_json"])
                for row in page_rows
            }
            observed_state = classify_template_apply_state(
                template_manifest,
                current_revision=template_row["revision"],
                current_page_ids=current_page_ids,
                current_layouts_by_page_id=current_layouts,
            )
            template_results.append({
                "template_id": template_id,
                "manifest_status": template_manifest["status"],
                "observed_state": observed_state,
                "current_revision": template_row["revision"],
            })
    expected_backup_count = sum(
        len(template_manifest["changed_page_ids"])
        for template_manifest in manifest.get("templates", [])
    )
    expected_backup_hashes = {
        page_id: page_hash
        for template_manifest in manifest.get("templates", [])
        for page_id, page_hash in template_manifest[
            "original_changed_page_layout_sha256"
        ].items()
    }
    observed_backup_hashes = {
        str(row["template_page_id"]): layout_sha256(json.loads(row["layout_json"]))
        for row in backup_rows
    }
    observed_backup_page_ids = [
        str(row["template_page_id"])
        for row in backup_rows
    ]
    backup_page_ids_match = (
        expected_backup_count == len(expected_backup_hashes)
        and len(observed_backup_page_ids) == len(expected_backup_hashes)
        and len(observed_backup_page_ids) == len(set(observed_backup_page_ids))
        and set(observed_backup_page_ids) == set(expected_backup_hashes)
    )
    backup_hashes_match = observed_backup_hashes == expected_backup_hashes
    return {
        "run_id": manifest["run_id"],
        "operation": manifest["operation"],
        "manifest_status": manifest["overall_status"],
        "backup_name": manifest["backup_name"],
        "backup_count": len(backup_rows),
        "expected_backup_count": expected_backup_count,
        "backup_page_ids_match": backup_page_ids_match,
        "backup_hashes_match": backup_hashes_match,
        "backup_complete": (
            backup_page_ids_match
            and backup_hashes_match
        ),
        "templates": template_results,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--manifest", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    database_path = args.db.resolve()
    manifest_path = args.manifest.resolve()
    if not database_path.is_file():
        print(f"錯誤：找不到資料庫 {database_path}", file=sys.stderr)
        return 2
    if not manifest_path.is_file():
        print(f"錯誤：找不到 manifest {manifest_path}", file=sys.stderr)
        return 2
    try:
        result = inspect_manifest(database_path, manifest_path)
    except (KeyError, OSError, ValueError, json.JSONDecodeError, sqlite3.DatabaseError) as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if (
        not result["backup_complete"]
        or any(
            item["observed_state"] in {"diverged", "missing_template"}
            for item in result["templates"]
        )
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
