"""唯讀驗證 2026-07 正式園所 replay 與 Project 203 修復結果。"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import sqlite3
import sys
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.migrate_production_organization_202607 import (  # noqa: E402
    MANIFEST_SCHEMA_VERSION as ORGANIZATION_MANIFEST_SCHEMA_VERSION,
    OPERATION as ORGANIZATION_OPERATION,
    PLAN_SCHEMA_VERSION as ORGANIZATION_PLAN_SCHEMA_VERSION,
    REPLACEMENT_TABLES as ORGANIZATION_REPLACEMENT_TABLES,
    _classify_database_state as _classify_organization_database_state,
    _planned_applied_component_values as _planned_organization_components,
    _state_component_values as _current_organization_components,
    _validate_manifest as _validate_organization_manifest,
)
from scripts.repair_project_203 import (  # noqa: E402
    APPLY_PLAN_SCHEMA_VERSION as PROJECT_203_APPLY_PLAN_SCHEMA_VERSION,
    MANIFEST_SCHEMA_VERSION as PROJECT_203_MANIFEST_SCHEMA_VERSION,
    OPERATION as PROJECT_203_OPERATION,
    PLAN_SCHEMA_VERSION as PROJECT_203_PLAN_SCHEMA_VERSION,
    _validate_reviewed_manifest as _validate_project_203_manifest,
)
from scripts.data_script_utils import safe_csv_value, write_manifest  # noqa: E402


SOURCE_PROJECT_COUNTS = {"total": 134, "active": 74, "archived": 60}
TARGET_PROJECT_COUNTS = {"total": 135, "active": 74, "archived": 61}
SOURCE_STUDENT_COUNT = 791
TARGET_STUDENT_COUNT = 799
# 這是來源既有資料唯一可變白名單；其餘來源 table 的來源欄位必須逐值完整保留。
SOURCE_MUTABLE_TABLES = frozenset({
    *ORGANIZATION_REPLACEMENT_TABLES,
    "legacy_project_classroom_migrations",
    "legacy_student_identity_resolutions",
    "legacy_teacher_supervisor_links",
    "projects",
    "roster_children",
    "students",
    "teacher_supervisors",
    "users",
})
ARCHIVED_PROJECT_IDS = (115, 199)
EXPECTED_REPLACEMENT_STUDENT_COUNT = 8
EXPECTED_ROLE_FIX_COUNT = 3
KNOWN_COMPOUND_SURNAMES = frozenset({
    "歐陽",
    "司馬",
    "上官",
    "諸葛",
    "夏侯",
    "東方",
    "皇甫",
    "尉遲",
    "公孫",
    "慕容",
    "司徒",
    "司空",
    "令狐",
    "宇文",
    "長孫",
    "南宮",
    "獨孤",
    "軒轅",
    "鍾離",
    "端木",
    "拓跋",
    "百里",
    "東郭",
    "西門",
    "呼延",
    "羊舌",
    "微生",
    "梁丘",
    "左丘",
    "公羊",
    "公冶",
    "公良",
})

SOURCE_PROJECT_COLUMNS = (
    "id",
    "name",
    "template_id",
    "owner_id",
    "created_at",
    "updated_at",
    "deleted_at",
    "archive_expires_at",
    "label_texts_json",
    "department",
    "template_period_id",
    "completed_at",
    "template_revision",
)
TARGET_PROJECT_STARTUP_COLUMNS = ("created_by_id", "created_by_name")
SOURCE_STUDENT_COLUMNS = (
    "id",
    "project_id",
    "name",
    "order_index",
    "pages_data_json",
    "output_filename",
    "created_at",
    "updated_at",
    "roster_child_id",
)
TARGET_STUDENT_STARTUP_COLUMNS = ("album_name",)
PROJECT_REPAIR_MUTABLE_COLUMNS = {
    "updated_at",
    "deleted_at",
    "archive_expires_at",
}
STUDENT_ORGANIZATION_COLUMNS = {"roster_child_id"}

SOURCE_REQUIRED_COLUMNS = {
    "users": {
        "id",
        "username",
        "hashed_password",
        "display_name",
        "role",
        "auth_version",
    },
    "projects": set(SOURCE_PROJECT_COLUMNS),
    "students": set(SOURCE_STUDENT_COLUMNS),
}
TARGET_REQUIRED_COLUMNS = {
    **SOURCE_REQUIRED_COLUMNS,
    "projects": {
        *SOURCE_PROJECT_COLUMNS,
        *TARGET_PROJECT_STARTUP_COLUMNS,
        "classroom_id",
        "class_period_work_slot_id",
        "campus_id_snapshot",
        "campus_name_snapshot",
        "classroom_name_snapshot",
    },
    "students": {
        *SOURCE_STUDENT_COLUMNS,
        *TARGET_STUDENT_STARTUP_COLUMNS,
    },
    "templates": {"id", "revision"},
    "campuses": {"id", "name", "is_active"},
    "classrooms": {"id", "campus_id", "name", "department", "is_active"},
    "roster_children": {"id", "name"},
    "class_roster_members": {
        "id",
        "classroom_id",
        "roster_child_id",
        "ended_at",
        "end_reason",
    },
    "classroom_teacher_assignments": {
        "id",
        "classroom_id",
        "teacher_id",
        "duty",
        "ended_at",
    },
    "organization_supervisor_assignments": {
        "id",
        "campus_id",
        "department",
        "supervisor_id",
        "ended_at",
    },
    "academic_terms": {"id", "label", "status", "migration_key"},
    "academic_term_classrooms": {
        "id",
        "academic_term_id",
        "classroom_id",
        "campus_id_snapshot",
        "campus_name_snapshot",
        "classroom_name_snapshot",
        "department",
    },
    "academic_term_classroom_students": {
        "id",
        "academic_term_id",
        "term_classroom_id",
        "source_membership_id",
        "roster_child_id_snapshot",
        "student_name_snapshot",
    },
    "academic_term_periods": {
        "id",
        "academic_term_id",
        "template_period_id",
        "period_name_snapshot",
        "department",
    },
    "term_reclassification_plans": {
        "id",
        "status",
        "target_academic_term_id",
    },
    "class_period_work_slots": {
        "id",
        "term_classroom_id",
        "term_period_id",
        "started_at",
    },
    "legacy_project_classroom_migrations": {
        "id",
        "project_id_snapshot",
    },
    "legacy_student_identity_resolutions": {
        "id",
        "migration_id",
        "project_id_snapshot",
        "student_id_snapshot",
        "resolved_roster_child_id_snapshot",
    },
}


@contextmanager
def _read_only_connection(
    database_path: Path,
    *,
    immutable: bool = False,
) -> Iterator[sqlite3.Connection]:
    immutable_parameter = "&immutable=1" if immutable else ""
    connection = sqlite3.connect(
        (
            f"file:{database_path.resolve().as_posix()}?mode=ro"
            f"{immutable_parameter}"
        ),
        uri=True,
    )
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA foreign_keys=ON")
        yield connection
    finally:
        connection.close()


class _StopAudit(Exception):
    """已有結構化失敗結果，不再執行依賴缺失 schema 的檢查。"""


@contextmanager
def _suppress_audit_stop() -> Iterator[None]:
    try:
        yield
    except _StopAudit:
        pass


@contextmanager
def _source_hash_guard(database_path: Path, expected_sha256: str) -> Iterator[None]:
    try:
        yield
    finally:
        _reject_source_sidecars(database_path)
        actual_sha256 = _file_sha256(database_path)
        if actual_sha256 != expected_sha256:
            raise ValueError("source DB 在 audit 開檔期間發生變動")


def _source_sidecar_paths(database_path: Path) -> tuple[Path, Path]:
    return (
        Path(f"{database_path}-wal"),
        Path(f"{database_path}-shm"),
    )


def _reject_source_sidecars(database_path: Path) -> None:
    existing_sidecars = [
        str(path.resolve())
        for path in _source_sidecar_paths(database_path)
        if path.exists()
    ]
    if existing_sidecars:
        raise ValueError(
            "source DB 不可帶 SQLite WAL/SHM sidecar："
            + "、".join(existing_sidecars)
        )


def _file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalized_sha256(value: str) -> str:
    normalized = value.strip().lower()
    if len(normalized) != 64 or any(
        character not in "0123456789abcdef" for character in normalized
    ):
        raise ValueError("source SHA-256 必須是 64 位十六進位字串")
    return normalized


def _rows(
    connection: sqlite3.Connection,
    sql: str,
    parameters: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(sql, parameters).fetchall()]


def _one(
    connection: sqlite3.Connection,
    sql: str,
    parameters: tuple[Any, ...] = (),
) -> dict[str, Any] | None:
    row = connection.execute(sql, parameters).fetchone()
    return dict(row) if row is not None else None


def _quoted_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _table_names(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in connection.execute(
            """SELECT name FROM sqlite_master
               WHERE type='table' AND name NOT LIKE 'sqlite_%'"""
        )
    }


def _table_columns(connection: sqlite3.Connection, table_name: str) -> list[str]:
    return [
        str(row[1])
        for row in connection.execute(
            f"PRAGMA table_info({_quoted_identifier(table_name)})"
        )
    ]


def _canonical_cell(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"sqlite_blob_hex": value.hex()}
    return value


def _semantic_table_digest(
    connection: sqlite3.Connection,
    table_name: str,
    columns: list[str],
) -> tuple[int, str]:
    column_sql = ", ".join(_quoted_identifier(column) for column in columns)
    table_sql = _quoted_identifier(table_name)
    canonical_rows = sorted(
        json.dumps(
            [_canonical_cell(value) for value in row],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        for row in connection.execute(f"SELECT {column_sql} FROM {table_sql}")
    )
    payload = json.dumps(
        {"columns": columns, "rows": canonical_rows},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return len(canonical_rows), hashlib.sha256(payload).hexdigest()


def _source_table_preservation(
    source: sqlite3.Connection,
    target: sqlite3.Connection,
) -> dict[str, Any]:
    source_tables = _table_names(source)
    target_tables = _table_names(target)
    preserved_tables = sorted(source_tables - SOURCE_MUTABLE_TABLES)
    missing_target_tables = sorted(set(preserved_tables) - target_tables)
    table_results: dict[str, Any] = {}
    for table_name in preserved_tables:
        source_columns = _table_columns(source, table_name)
        target_columns = (
            _table_columns(target, table_name)
            if table_name in target_tables
            else []
        )
        missing_columns = sorted(set(source_columns) - set(target_columns))
        result: dict[str, Any] = {
            "source_columns": source_columns,
            "missing_target_columns": missing_columns,
        }
        if table_name in target_tables and not missing_columns:
            source_count, source_sha256 = _semantic_table_digest(
                source, table_name, source_columns
            )
            target_count, target_sha256 = _semantic_table_digest(
                target, table_name, source_columns
            )
            result.update({
                "source_count": source_count,
                "target_count": target_count,
                "source_sha256": source_sha256,
                "target_sha256": target_sha256,
                "matches": (
                    source_count == target_count
                    and source_sha256 == target_sha256
                ),
            })
        else:
            result["matches"] = False
        table_results[table_name] = result
    mismatched_tables = [
        table_name
        for table_name, result in table_results.items()
        if not result["matches"]
    ]
    return {
        "ok": not missing_target_tables and not mismatched_tables,
        "allowed_mutable_source_tables": sorted(SOURCE_MUTABLE_TABLES),
        "preserved_source_tables": preserved_tables,
        "new_target_tables": sorted(target_tables - source_tables),
        "missing_target_tables": missing_target_tables,
        "mismatched_tables": mismatched_tables,
        "tables": table_results,
    }


def _add_check(
    checks: list[dict[str, Any]],
    name: str,
    *,
    ok: bool,
    expected: Any,
    actual: Any,
    details: Any | None = None,
) -> None:
    check = {
        "name": name,
        "ok": ok,
        "expected": expected,
        "actual": actual,
    }
    if details is not None:
        check["details"] = details
    checks.append(check)


def _finalize_result(
    database_path: Path,
    source_database_path: Path,
    checks: list[dict[str, Any]],
    organization_manifest_path: Path | None = None,
    project_203_manifest_path: Path | None = None,
) -> dict[str, Any]:
    failed_count = sum(not check["ok"] for check in checks)
    result = {
        "schema": "production-migration-audit-202607-v1",
        "ok": failed_count == 0,
        "contains_personal_data": True,
        "database": str(database_path.resolve()),
        "source_database": str(source_database_path.resolve()),
        "summary": {
            "passed": len(checks) - failed_count,
            "failed": failed_count,
            "total": len(checks),
        },
        "checks": checks,
    }
    if organization_manifest_path is not None:
        result["organization_manifest"] = str(
            organization_manifest_path.resolve()
        )
    if project_203_manifest_path is not None:
        result["project_203_manifest"] = str(project_203_manifest_path.resolve())
    return result


def _terminal_summary(result: dict[str, Any]) -> dict[str, Any]:
    """stdout 只顯示不含姓名、資料列與本機路徑的執行摘要。"""
    summary = {
        "schema": result.get("schema"),
        "ok": bool(result.get("ok")),
        "summary": result.get("summary"),
        "checks": [
            {"name": check.get("name"), "ok": bool(check.get("ok"))}
            for check in result.get("checks", [])
        ],
    }
    if result.get("output") is not None:
        summary["output_written"] = True
    return summary


def _schema_errors(
    connection: sqlite3.Connection,
    required_columns: dict[str, set[str]],
) -> dict[str, Any]:
    table_names = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    missing_tables = sorted(set(required_columns) - table_names)
    missing_columns = {}
    for table_name in sorted(set(required_columns) & table_names):
        actual_columns = {
            str(row[1])
            for row in connection.execute(f'PRAGMA table_info("{table_name}")')
        }
        missing = sorted(required_columns[table_name] - actual_columns)
        if missing:
            missing_columns[table_name] = missing
    return {
        "missing_tables": missing_tables,
        "missing_columns": missing_columns,
    }


def _integrity_rows(connection: sqlite3.Connection) -> list[str]:
    return [str(row[0]) for row in connection.execute("PRAGMA integrity_check")]


def _foreign_key_rows(connection: sqlite3.Connection) -> list[list[Any]]:
    return [list(row) for row in connection.execute("PRAGMA foreign_key_check")]


def _project_counts(connection: sqlite3.Connection) -> dict[str, int]:
    row = connection.execute(
        """SELECT COUNT(*) AS total,
                  SUM(deleted_at IS NULL) AS active,
                  SUM(deleted_at IS NOT NULL) AS archived
           FROM projects"""
    ).fetchone()
    if row is None:
        return {"total": 0, "active": 0, "archived": 0}
    return {
        "total": int(row["total"] or 0),
        "active": int(row["active"] or 0),
        "archived": int(row["archived"] or 0),
    }


def _rows_by_id(
    connection: sqlite3.Connection,
    table_name: str,
    columns: tuple[str, ...],
) -> dict[int, dict[str, Any]]:
    column_sql = ", ".join(columns)
    return {
        int(row["id"]): row
        for row in _rows(
            connection,
            f"SELECT {column_sql} FROM {table_name} ORDER BY id",
        )
    }


def _value_summary(value: Any) -> Any:
    if not isinstance(value, str) or len(value) <= 160:
        return value
    return {
        "length": len(value),
        "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
    }


def _content_mismatches(
    source_rows: dict[int, dict[str, Any]],
    target_rows: dict[int, dict[str, Any]],
    columns: tuple[str, ...],
    *,
    mutable_columns_by_id: dict[int, set[str]] | None = None,
) -> list[dict[str, Any]]:
    mutable_columns_by_id = mutable_columns_by_id or {}
    mismatches = []
    for row_id, source_row in source_rows.items():
        target_row = target_rows.get(row_id)
        if target_row is None:
            mismatches.append({"id": row_id, "error": "missing_target_row"})
            continue
        mutable_columns = mutable_columns_by_id.get(row_id, set())
        for column in columns:
            if column == "id" or column in mutable_columns:
                continue
            if source_row[column] == target_row[column]:
                continue
            mismatches.append({
                "id": row_id,
                "column": column,
                "source": _value_summary(source_row[column]),
                "target": _value_summary(target_row[column]),
            })
            if len(mismatches) >= 20:
                return mismatches
    return mismatches


def _count_total_current(
    connection: sqlite3.Connection,
    table_name: str,
) -> dict[str, int]:
    row = connection.execute(
        f"""SELECT COUNT(*) AS total,
                   SUM(ended_at IS NULL) AS current
            FROM {table_name}"""
    ).fetchone()
    if row is None:
        return {"total": 0, "current": 0}
    return {
        "total": int(row["total"] or 0),
        "current": int(row["current"] or 0),
    }


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _is_han_character(character: str) -> bool:
    codepoint = ord(character)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
    )


def _expected_automatic_album_names(full_names: list[str]) -> list[str | None]:
    candidates: list[str | None] = []
    normalized_names = [name.strip() for name in full_names]
    for name in normalized_names:
        candidate = None
        if (
            len(name) in {2, 3}
            and all(_is_han_character(character) for character in name)
            and name[:2] not in KNOWN_COMPOUND_SURNAMES
        ):
            candidate = name[1:]
        candidates.append(candidate)
    active_candidates = [candidate is not None for candidate in candidates]
    while True:
        effective_names = [
            candidate if is_active else full_name
            for candidate, full_name, is_active in zip(
                candidates,
                normalized_names,
                active_candidates,
                strict=True,
            )
        ]
        counts = Counter(effective_names)
        collisions = [
            index
            for index, (effective_name, is_active) in enumerate(
                zip(effective_names, active_candidates, strict=True)
            )
            if is_active and counts[effective_name] > 1
        ]
        if not collisions:
            break
        for index in collisions:
            active_candidates[index] = False
    return [
        candidate if is_active else None
        for candidate, is_active in zip(
            candidates,
            active_candidates,
            strict=True,
        )
    ]


def _organization_component_comparison(
    connection: sqlite3.Connection,
    plan: dict[str, Any],
    replacement_work_slot_id: int,
) -> dict[str, Any]:
    raw_state = _classify_organization_database_state(connection, plan)
    current_components = _current_organization_components(connection, plan)
    expected_components = _planned_organization_components(plan)
    normalized_components = copy.deepcopy(current_components)
    slot_component_name = "table:class_period_work_slots"
    current_slot_rows = normalized_components.get(slot_component_name, [])
    expected_slot_rows = expected_components.get(slot_component_name, [])
    current_replacement_slot = next(
        (
            row
            for row in current_slot_rows
            if int(row.get("id", -1)) == replacement_work_slot_id
        ),
        None,
    )
    expected_replacement_slot = next(
        (
            row
            for row in expected_slot_rows
            if int(row.get("id", -1)) == replacement_work_slot_id
        ),
        None,
    )
    authorized_slot_delta = bool(
        current_replacement_slot
        and expected_replacement_slot
        and current_replacement_slot.get("started_at") is not None
        and expected_replacement_slot.get("started_at") is None
    )
    if authorized_slot_delta:
        current_replacement_slot["started_at"] = expected_replacement_slot[
            "started_at"
        ]
    component_names = sorted(set(normalized_components) | set(expected_components))
    mismatched_components = [
        component_name
        for component_name in component_names
        if normalized_components.get(component_name)
        != expected_components.get(component_name)
    ]
    return {
        "ok": authorized_slot_delta and not mismatched_components,
        "raw_state": raw_state,
        "authorized_delta": {
            "component": slot_component_name,
            "row_id": replacement_work_slot_id,
            "column": "started_at",
            "actual": (
                next(
                    (
                        row.get("started_at")
                        for row in current_components.get(slot_component_name, [])
                        if int(row.get("id", -1)) == replacement_work_slot_id
                    ),
                    None,
                )
            ),
            "reviewed": (
                expected_replacement_slot
                and expected_replacement_slot.get("started_at")
            ),
        },
        "mismatched_components": mismatched_components,
    }


def _reviewed_user_role_updates(
    plan: dict[str, Any],
) -> dict[int, dict[str, Any]]:
    updates: dict[int, dict[str, Any]] = {}
    for raw_update in plan["user_updates"]:
        user_id = int(raw_update["id"])
        if user_id in updates:
            raise ValueError(f"reviewed user_updates 有重複 id：{user_id}")
        update = {
            "id": user_id,
            "display_name": str(raw_update["display_name"]),
            "source_role": str(raw_update["source_role"]),
            "source_auth_version": int(raw_update["source_auth_version"]),
            "role": str(raw_update["role"]),
            "auth_version": int(raw_update["auth_version"]),
        }
        if (
            not update["display_name"]
            or update["source_role"] != "supervisor"
            or update["role"] != "teacher"
            or update["auth_version"] != update["source_auth_version"] + 1
        ):
            raise ValueError(f"reviewed user_updates 語意不符：User {user_id}")
        updates[user_id] = update
    if len(updates) != EXPECTED_ROLE_FIX_COUNT:
        raise ValueError(
            "reviewed user_updates 筆數不符："
            f"預期 {EXPECTED_ROLE_FIX_COUNT}，實際 {len(updates)}"
        )
    return updates


def _reviewed_historical_roster_members(
    connection: sqlite3.Connection,
    plan: dict[str, Any],
) -> dict[str, Any]:
    expected_components = _planned_organization_components(plan)
    current_components = _current_organization_components(connection, plan)
    component_name = "table:class_roster_members"
    expected_rows = [
        row
        for row in expected_components[component_name]
        if row.get("ended_at") is not None
    ]
    current_rows = [
        row
        for row in current_components[component_name]
        if row.get("ended_at") is not None
    ]

    # 姓名只從私有 reviewed manifest 取值；公開腳本不保存姓名／ID 對照。
    reviewed_child_rows = [
        *plan["source_guard"]["existing_roster_children"],
        *plan["roster_children_to_insert"]["rows"],
    ]
    reviewed_child_names: dict[int, str] = {}
    for child_row in reviewed_child_rows:
        child_id = int(child_row["id"])
        child_name = str(child_row["name"])
        existing_name = reviewed_child_names.get(child_id)
        if existing_name is not None and existing_name != child_name:
            raise ValueError(f"reviewed RosterChild {child_id} 姓名互相衝突")
        reviewed_child_names[child_id] = child_name

    expected_evidence = []
    actual_evidence = []
    for row in expected_rows:
        child_id = int(row["roster_child_id"])
        if child_id not in reviewed_child_names:
            raise ValueError(
                f"reviewed ended member 的 RosterChild {child_id} 缺少姓名證據"
            )
        expected_evidence.append({
            "membership": row,
            "child_name": reviewed_child_names[child_id],
        })
    for row in current_rows:
        child_id = int(row["roster_child_id"])
        child = _one(
            connection,
            "SELECT name FROM roster_children WHERE id=?",
            (child_id,),
        )
        actual_evidence.append({
            "membership": row,
            "child_name": child and str(child["name"]),
        })
    return {
        "ok": (
            len(expected_evidence) == 1
            and actual_evidence == expected_evidence
        ),
        "expected": expected_evidence,
        "actual": actual_evidence,
    }


def _organization_plan_coverage(
    manifest: dict[str, Any],
    plan: dict[str, Any],
    expected_project_ids: set[int],
    expected_student_pairs: set[tuple[int, int]],
    repaired_project_id: int,
) -> dict[str, Any]:
    try:
        replay_project_ids = {
            int(project_id) for project_id in plan["replay_project_ids"]
        }
        project_update_ids = {
            int(row["id"]) for row in plan["project_updates"]
        }
        student_update_pairs = {
            (int(row["project_id"]), int(row["id"]))
            for row in plan["student_updates"]
        }
        ledger_plan = plan["ledger_rows"]
        header_project_ids = {
            int(row["project_id_snapshot"])
            for row in ledger_plan[
                "legacy_project_classroom_migrations"
            ]["rows"]
        }
        resolution_pairs = {
            (int(row["project_id_snapshot"]), int(row["student_id_snapshot"]))
            for row in ledger_plan[
                "legacy_student_identity_resolutions"
            ]["rows"]
        }
        reviewed_user_updates = _reviewed_user_role_updates(plan)
        user_update_ids = set(reviewed_user_updates)
        analysis = plan["analysis"]
        inserted_children = plan["roster_children_to_insert"]["rows"]
        deleted_children = plan["roster_children_to_delete"]["rows"]
        legacy_teacher_links = plan[
            "preserved_legacy_teacher_supervisor_links"
        ]["rows"]
        component_keys = set(plan["applied_state_component_sha256"])
        source_component_keys = set(plan["source_state_component_sha256"])
        expected_component_keys = {
            *(f"table:{table_name}" for table_name in ORGANIZATION_REPLACEMENT_TABLES),
            "roster_children_to_insert",
            "roster_children_to_delete",
            "project_organization",
            "student_identity",
            "ledger:legacy_project_classroom_migrations",
            "ledger:legacy_student_identity_resolutions",
            "user_access_roles",
            "legacy_teacher_supervisor_links",
        }
        actual = {
            "replacement_tables": sorted(plan["replacement_tables"]),
            "replay_projects": len(replay_project_ids),
            "project_updates": len(project_update_ids),
            "student_updates": len(student_update_pairs),
            "ledger_headers": len(header_project_ids),
            "ledger_resolutions": len(resolution_pairs),
            "user_updates": sorted(user_update_ids),
            "inserted_children": len(inserted_children),
            "deleted_children": len(deleted_children),
            "legacy_teacher_links": len(legacy_teacher_links),
            "applied_project_count": manifest.get("applied_project_count"),
            "applied_student_count": manifest.get("applied_student_count"),
            "component_keys": sorted(component_keys),
        }
        ok = (
            set(plan["replacement_tables"])
            == set(ORGANIZATION_REPLACEMENT_TABLES)
            and replay_project_ids == expected_project_ids
            and project_update_ids == expected_project_ids
            and student_update_pairs == expected_student_pairs
            and header_project_ids == expected_project_ids
            and resolution_pairs == expected_student_pairs
            and set(ledger_plan)
            == {
                "legacy_project_classroom_migrations",
                "legacy_student_identity_resolutions",
            }
            and len(user_update_ids) == EXPECTED_ROLE_FIX_COUNT
            and plan.get("excluded_project_ids") == [repaired_project_id]
            and plan.get("required_archived_project_ids")
            == list(ARCHIVED_PROJECT_IDS)
            and analysis["replay_project_count"] == len(expected_project_ids)
            and analysis["replay_student_count"] == len(expected_student_pairs)
            and analysis["added_roster_child_count"] == len(inserted_children)
            and analysis["deleted_roster_child_count"] == len(deleted_children)
            and analysis["legacy_teacher_link_count"] == len(legacy_teacher_links)
            and analysis["user_role_update_count"] == len(user_update_ids)
            and len(legacy_teacher_links) == 161
            and manifest.get("applied_project_count") == len(expected_project_ids)
            and manifest.get("applied_student_count") == len(expected_student_pairs)
            and component_keys == expected_component_keys
            and source_component_keys == expected_component_keys
        )
        return {"ok": ok, **actual}
    except (KeyError, TypeError, ValueError) as error:
        return {"ok": False, "error": str(error)}


PROJECT_203_REPORT_FIELDS = (
    "run_id",
    "review_plan_sha256",
    "action",
    "source_project_id",
    "work_slot_id",
    "campus",
    "classroom",
    "period",
    "order_index",
    "membership_id",
    "term_student_id",
    "roster_child_id",
    "full_name",
    "album_name",
)


def _reviewed_work_slot_period_name(
    organization_plan: dict[str, Any],
    work_slot_id: int,
) -> str:
    slot_rows = organization_plan["replacement_tables"][
        "class_period_work_slots"
    ]["rows"]
    matching_slots = [
        row for row in slot_rows if int(row["id"]) == work_slot_id
    ]
    if len(matching_slots) != 1:
        raise ValueError(f"reviewed organization plan 找不到唯一工作格 {work_slot_id}")
    term_period_id = int(matching_slots[0]["term_period_id"])
    period_rows = organization_plan["replacement_tables"][
        "academic_term_periods"
    ]["rows"]
    matching_periods = [
        row for row in period_rows if int(row["id"]) == term_period_id
    ]
    if len(matching_periods) != 1:
        raise ValueError(
            f"reviewed organization plan 找不到工作格期別 {term_period_id}"
        )
    return str(matching_periods[0]["period_name_snapshot"])


def _csv_string(value: Any) -> str:
    safe_value = safe_csv_value(value)
    return "" if safe_value is None else str(safe_value)


def _project_203_report_comparison(
    manifest: dict[str, Any],
    manifest_path: Path,
    plan: dict[str, Any],
    organization_plan: dict[str, Any],
) -> dict[str, Any]:
    report_path = manifest_path.with_name(str(manifest["report_filename"]))
    with report_path.open("r", encoding="utf-8-sig", newline="") as report_file:
        reader = csv.DictReader(report_file)
        fieldnames = reader.fieldnames or []
        actual_rows = [dict(row) for row in reader]
    project = plan["replacement_project"]
    target_project_id = int(plan["target_project_id"])
    target_work_slot_id = int(plan["target_work_slot_id"])
    organization_period_name = _reviewed_work_slot_period_name(
        organization_plan,
        target_work_slot_id,
    )
    period_name = str(plan["target_context"]["period_name_snapshot"])
    if period_name != organization_period_name:
        raise ValueError("Project 203 與 organization plan 的工作格期別不一致")
    expected_rows = [
        {
            "run_id": _csv_string(manifest["run_id"]),
            "review_plan_sha256": _csv_string(manifest["review_plan_sha256"]),
            "action": "archive_project_203_and_create_replacement",
            "source_project_id": str(target_project_id),
            "work_slot_id": str(target_work_slot_id),
            "campus": _csv_string(project["campus_name_snapshot"]),
            "classroom": _csv_string(project["classroom_name_snapshot"]),
            "period": period_name,
            "order_index": str(student["order_index"]),
            "membership_id": str(student["membership_id"]),
            "term_student_id": str(student["term_student_id"]),
            "roster_child_id": str(student["roster_child_id"]),
            "full_name": _csv_string(student["name"]),
            "album_name": _csv_string(student["album_name"]),
        }
        for student in plan["students"]
    ]
    mismatch_indexes = [
        index
        for index, (actual, expected) in enumerate(
            zip(actual_rows, expected_rows, strict=False)
        )
        if actual != expected
    ]
    return {
        "ok": (
            fieldnames == list(PROJECT_203_REPORT_FIELDS)
            and actual_rows == expected_rows
        ),
        "expected_fields": list(PROJECT_203_REPORT_FIELDS),
        "actual_fields": fieldnames,
        "expected_row_count": len(expected_rows),
        "actual_row_count": len(actual_rows),
        "mismatch_indexes": mismatch_indexes[:20],
    }


def _project_203_manifest_database_comparison(
    manifest: dict[str, Any],
    plan: dict[str, Any],
    source_project: dict[str, Any] | None,
    target_project: dict[str, Any] | None,
    replacement_project: dict[str, Any] | None,
    replacement_students: list[dict[str, Any]],
    replacement_creator: dict[str, Any] | None,
    slot: dict[str, Any] | None,
    template: dict[str, Any] | None,
    memberships: list[dict[str, Any]],
    term_students: list[dict[str, Any]],
) -> dict[str, Any]:
    try:
        apply_plan = manifest["apply_plan"]
        if not isinstance(apply_plan, dict):
            raise ValueError("Project 203 apply plan 不存在")
        if (
            source_project is None
            or target_project is None
            or replacement_project is None
        ):
            raise ValueError("來源 Project 203、目標 Project 203 或 replacement 不存在")
        if replacement_creator is None or slot is None or template is None:
            raise ValueError("replacement 建立者、工作格或模板不存在")
        target_project_id = int(plan["target_project_id"])
        target_work_slot_id = int(plan["target_work_slot_id"])

        project_fields = (
            "name",
            "template_id",
            "template_revision",
            "owner_id",
            "label_texts_json",
            "department",
            "template_period_id",
            "classroom_id",
            "class_period_work_slot_id",
            "created_by_id",
            "created_by_name",
            "campus_id_snapshot",
            "campus_name_snapshot",
            "classroom_name_snapshot",
        )
        term_by_child_id = {
            int(student["roster_child_id"]): student for student in term_students
        }
        membership_ids = [int(member["membership_id"]) for member in memberships]
        membership_child_ids = [
            int(member["roster_child_id"]) for member in memberships
        ]
        term_student_ids = [
            int(student["term_student_id"]) for student in term_students
        ]
        term_child_ids = [
            int(student["roster_child_id"]) for student in term_students
        ]
        automatic_album_names = _expected_automatic_album_names([
            str(member["student_name"]) for member in memberships
        ])
        expected_students = []
        membership_contract_ok = (
            len(memberships) == EXPECTED_REPLACEMENT_STUDENT_COUNT
            and len(term_students) == EXPECTED_REPLACEMENT_STUDENT_COUNT
            and len(set(membership_ids)) == EXPECTED_REPLACEMENT_STUDENT_COUNT
            and len(set(membership_child_ids))
            == EXPECTED_REPLACEMENT_STUDENT_COUNT
            and len(set(term_student_ids)) == EXPECTED_REPLACEMENT_STUDENT_COUNT
            and len(term_by_child_id) == EXPECTED_REPLACEMENT_STUDENT_COUNT
            and set(membership_child_ids) == set(term_child_ids)
        )
        for order_index, (member, album_name) in enumerate(
            zip(memberships, automatic_album_names, strict=True)
        ):
            roster_child_id = int(member["roster_child_id"])
            term_student = term_by_child_id.get(roster_child_id)
            if term_student is None:
                membership_contract_ok = False
                continue
            membership_contract_ok = membership_contract_ok and bool(
                int(term_student["source_membership_id"])
                == int(member["membership_id"])
                and int(term_student["academic_term_id"])
                == int(slot["academic_term_id"])
                and str(term_student["student_name"])
                == str(member["student_name"])
            )
            expected_students.append({
                "order_index": order_index,
                "membership_id": int(member["membership_id"]),
                "term_student_id": int(term_student["term_student_id"]),
                "roster_child_id": roster_child_id,
                "name": str(member["student_name"]),
                "album_name": album_name,
            })

        slot_contract = {
            "slot_id": int(slot["id"]) == target_work_slot_id,
            "reviewed_target_context": all(
                slot[field] == expected_value
                for field, expected_value in plan["target_context"].items()
            ),
            "term_status": slot["term_status"] in {"imported", "active"},
            "campus_id": (
                slot["campus_id_snapshot"]
                == plan["replacement_project"]["campus_id_snapshot"]
            ),
            "campus_snapshot": (
                slot["campus_name_snapshot"]
                == plan["replacement_project"]["campus_name_snapshot"]
            ),
            "classroom_id": (
                slot["classroom_id"]
                == plan["replacement_project"]["classroom_id"]
            ),
            "classroom_snapshot": (
                slot["classroom_name_snapshot"]
                == plan["replacement_project"]["classroom_name_snapshot"]
            ),
            "period_snapshot": (
                slot["period_name_snapshot"]
                == template["period_name"]
            ),
            "department": (
                slot["classroom_department"]
                == plan["replacement_project"]["department"]
                and slot["period_department"]
                == plan["replacement_project"]["department"]
                and slot["current_classroom_department"]
                == plan["replacement_project"]["department"]
            ),
            "current_organization": (
                slot["current_campus_id"] == slot["campus_id_snapshot"]
                and slot["current_campus_name"]
                == slot["campus_name_snapshot"]
                and slot["current_classroom_name"]
                == slot["classroom_name_snapshot"]
                and bool(slot["campus_is_active"])
                and bool(slot["classroom_is_active"])
            ),
            "template_period": (
                int(slot["template_period_id"])
                == int(source_project["template_period_id"])
            ),
        }
        template_contract = {
            "reviewed_template": all(
                template[field] == expected_value
                for field, expected_value in plan["template"].items()
            ),
            "template_id": int(template["id"])
            == int(source_project["template_id"])
            == int(plan["replacement_project"]["template_id"]),
            "period_id": (
                int(template["period_id"])
                == int(source_project["template_period_id"])
                == int(slot["template_period_id"])
                == int(plan["replacement_project"]["template_period_id"])
            ),
            "period_name": (
                template["period_name"] == slot["period_name_snapshot"]
            ),
            "department": (
                template["department"]
                == source_project["department"]
                == plan["replacement_project"]["department"]
            ),
            "status": template["status"] == "active",
        }
        source_project_contract = {
            "source_database_immutable_fields": all(
                source_project[field] == plan["source_project"][field]
                for field in SOURCE_PROJECT_COLUMNS
                if field not in PROJECT_REPAIR_MUTABLE_COLUMNS
            ),
            "reference_project_id": (
                int(plan["source_project"]["id"]) == target_project_id
            ),
            "reference_work_slot": (
                int(plan["source_project"]["class_period_work_slot_id"])
                == target_work_slot_id
            ),
            "reference_classroom": (
                plan["source_project"]["classroom_id"]
                == plan["target_context"]["classroom_id"]
            ),
            "reference_campus": (
                plan["source_project"]["campus_id_snapshot"]
                == plan["target_context"]["campus_id_snapshot"]
                and plan["source_project"]["campus_name_snapshot"]
                == plan["target_context"]["campus_name_snapshot"]
            ),
            "reference_classroom_snapshot": (
                plan["source_project"]["classroom_name_snapshot"]
                == plan["target_context"]["classroom_name_snapshot"]
            ),
        }
        expected_project = {
            "name": source_project["name"],
            "template_id": source_project["template_id"],
            "template_revision": template["revision"],
            "owner_id": source_project["owner_id"],
            "label_texts_json": source_project["label_texts_json"],
            "department": slot["classroom_department"],
            "template_period_id": slot["template_period_id"],
            "classroom_id": slot["classroom_id"],
            "class_period_work_slot_id": target_work_slot_id,
            "created_by_id": replacement_creator["id"],
            "created_by_name": replacement_creator["display_name"],
            "campus_id_snapshot": slot["campus_id_snapshot"],
            "campus_name_snapshot": slot["campus_name_snapshot"],
            "classroom_name_snapshot": slot["classroom_name_snapshot"],
        }
        expected_plan_binding = {
            "schema_version": PROJECT_203_PLAN_SCHEMA_VERSION,
            "operation": PROJECT_203_OPERATION,
            "target_project_id": target_project_id,
            "target_work_slot_id": target_work_slot_id,
            "archive_days": 30,
            "actor": {
                "id": replacement_creator["id"],
                "username": replacement_creator["username"],
                "display_name": replacement_creator["display_name"],
                "role": replacement_creator["role"],
            },
            "replacement_project": expected_project,
            "students": expected_students,
        }
        actual_plan_binding = {
            "schema_version": plan.get("schema_version"),
            "operation": plan.get("operation"),
            "target_project_id": plan.get("target_project_id"),
            "target_work_slot_id": plan.get("target_work_slot_id"),
            "archive_days": plan.get("archive_days"),
            "actor": plan.get("actor"),
            "replacement_project": plan.get("replacement_project"),
            "students": plan.get("students"),
        }
        database_project_binding = {
            field: replacement_project[field] for field in project_fields
        }
        database_student_binding = [
            {
                field: student[field]
                for field in ("order_index", "roster_child_id", "name", "album_name")
            }
            for student in replacement_students
        ]
        expected_database_students = [
            {
                field: student[field]
                for field in ("order_index", "roster_child_id", "name", "album_name")
            }
            for student in expected_students
        ]
        applied_at = target_project["deleted_at"]
        expected_apply_plan = {
            "schema_version": PROJECT_203_APPLY_PLAN_SCHEMA_VERSION,
            "applied_at": applied_at,
            "archive_expires_at": target_project["archive_expires_at"],
            "replacement_project_id": replacement_project["id"],
            "student_ids": [student["id"] for student in replacement_students],
        }
        timestamp_binding = {
            "project_updated_at": target_project["updated_at"],
            "slot_started_at": slot["started_at"],
            "replacement_created_at": replacement_project["created_at"],
            "replacement_updated_at": replacement_project["updated_at"],
            "student_created_at": [
                student["created_at"] for student in replacement_students
            ],
            "student_updated_at": [
                student["updated_at"] for student in replacement_students
            ],
        }
        timestamps_match = bool(
            applied_at
            and all(
                value == applied_at
                for key, value in timestamp_binding.items()
                if not key.startswith("student_")
            )
            and all(
                value == applied_at
                for key, values in timestamp_binding.items()
                if key.startswith("student_")
                for value in values
            )
        )
        return {
            "ok": (
                actual_plan_binding == expected_plan_binding
                and database_project_binding == expected_project
                and database_student_binding == expected_database_students
                and apply_plan == expected_apply_plan
                and timestamps_match
                and membership_contract_ok
                and all(slot_contract.values())
                and all(template_contract.values())
                and all(source_project_contract.values())
            ),
            "plan_binding": {
                "expected": expected_plan_binding,
                "actual": actual_plan_binding,
            },
            "database_binding": {
                "expected_project": expected_project,
                "actual_project": database_project_binding,
                "expected_students": expected_database_students,
                "actual_students": database_student_binding,
            },
            "slot_contract": slot_contract,
            "template_contract": template_contract,
            "source_project_contract": source_project_contract,
            "membership_contract": {
                "ok": membership_contract_ok,
                "memberships": len(memberships),
                "term_students": len(term_students),
                "membership_ids": membership_ids,
                "term_student_ids": term_student_ids,
                "membership_roster_child_ids": membership_child_ids,
                "term_roster_child_ids": term_child_ids,
            },
            "apply_plan": {
                "expected": expected_apply_plan,
                "actual": apply_plan,
            },
            "timestamp_binding": timestamp_binding,
        }
    except (KeyError, TypeError, ValueError) as error:
        return {"ok": False, "error": str(error)}


def audit_production_migration(
    database_path: Path,
    source_database_path: Path,
    expected_source_sha256: str,
    organization_manifest_path: Path,
    project_203_manifest_path: Path,
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    normalized_source_sha256 = _normalized_sha256(expected_source_sha256)
    _reject_source_sidecars(source_database_path)
    source_sha256_before = _file_sha256(source_database_path)
    if source_sha256_before != normalized_source_sha256:
        _add_check(
            checks,
            "source_database_sha256",
            ok=False,
            expected=normalized_source_sha256,
            actual={"before_open": source_sha256_before},
        )
        return _finalize_result(
            database_path,
            source_database_path,
            checks,
            organization_manifest_path,
            project_203_manifest_path,
        )
    try:
        manifest_value = json.loads(
            organization_manifest_path.read_text(encoding="utf-8")
        )
        if not isinstance(manifest_value, dict):
            raise ValueError("organization manifest root 必須是 object")
        organization_plan, organization_plan_sha256 = (
            _validate_organization_manifest(manifest_value)
        )
    except (OSError, json.JSONDecodeError, TypeError, KeyError, ValueError) as error:
        _add_check(
            checks,
            "organization_manifest_contract",
            ok=False,
            expected={
                "manifest_schema_version": ORGANIZATION_MANIFEST_SCHEMA_VERSION,
                "plan_schema_version": ORGANIZATION_PLAN_SCHEMA_VERSION,
                "operation": ORGANIZATION_OPERATION,
                "review_plan_sha256": "valid",
            },
            actual={"error": str(error)},
        )
        return _finalize_result(
            database_path,
            source_database_path,
            checks,
            organization_manifest_path,
            project_203_manifest_path,
        )
    _add_check(
        checks,
        "organization_manifest_contract",
        ok=True,
        expected={
            "manifest_schema_version": ORGANIZATION_MANIFEST_SCHEMA_VERSION,
            "plan_schema_version": ORGANIZATION_PLAN_SCHEMA_VERSION,
            "operation": ORGANIZATION_OPERATION,
            "review_plan_sha256": organization_plan_sha256,
        },
        actual={
            "manifest_schema_version": manifest_value.get("schema_version"),
            "plan_schema_version": organization_plan.get("schema_version"),
            "operation": manifest_value.get("operation"),
            "review_plan_sha256": manifest_value.get("review_plan_sha256"),
        },
    )
    organization_status = {
        "mode": manifest_value.get("mode"),
        "overall_status": manifest_value.get("overall_status"),
        "database_status": manifest_value.get("database_status"),
        "database_reconciliation": manifest_value.get("database_reconciliation"),
    }
    expected_organization_status = {
        "mode": "reviewed-apply",
        "overall_status": "complete",
        "database_status": "applied",
        "database_reconciliation": "applied",
    }
    _add_check(
        checks,
        "organization_manifest_applied_status",
        ok=organization_status == expected_organization_status,
        expected=expected_organization_status,
        actual=organization_status,
    )
    reference_database_sha256 = organization_plan.get(
        "reference_database_sha256"
    )
    reference_database_sha256_ok = bool(
        isinstance(reference_database_sha256, str)
        and len(reference_database_sha256) == 64
        and all(
            character in "0123456789abcdef"
            for character in reference_database_sha256.lower()
        )
    )
    _add_check(
        checks,
        "organization_manifest_reference_database",
        ok=reference_database_sha256_ok,
        expected="valid SHA-256 pinned by organization manifest contract",
        actual=reference_database_sha256,
    )
    try:
        project_203_manifest_value = json.loads(
            project_203_manifest_path.read_text(encoding="utf-8")
        )
        if not isinstance(project_203_manifest_value, dict):
            raise ValueError("Project 203 manifest root 必須是 object")
        project_203_plan = _validate_project_203_manifest(
            project_203_manifest_value,
            project_203_manifest_path,
        )
        if project_203_plan.get("operation") != PROJECT_203_OPERATION:
            raise ValueError("Project 203 review plan operation 不符")
        if (
            project_203_plan.get("reference_database_sha256")
            != reference_database_sha256
        ):
            raise ValueError(
                "Project 203 與 organization manifest 的 reference DB 不一致"
            )
        if (
            project_203_plan.get("target_work_slot_id")
            != organization_plan.get("excluded_project_work_slot_id")
        ):
            raise ValueError(
                "Project 203 與 organization manifest 的工作格不一致"
            )
        project_203_status = {
            "mode": project_203_manifest_value.get("mode"),
            "overall_status": project_203_manifest_value.get("overall_status"),
            "database_status": project_203_manifest_value.get("database_status"),
        }
        expected_project_203_status = {
            "mode": "reviewed-apply",
            "overall_status": "complete",
            "database_status": "applied",
        }
        if project_203_status != expected_project_203_status:
            raise ValueError(
                "Project 203 manifest 尚非完整已套用狀態："
                f"{project_203_status}"
            )
        if not isinstance(project_203_manifest_value.get("apply_plan"), dict):
            raise ValueError("Project 203 manifest 缺少已套用 apply plan")
        project_203_report_result = _project_203_report_comparison(
            project_203_manifest_value,
            project_203_manifest_path,
            project_203_plan,
            organization_plan,
        )
        if not project_203_report_result["ok"]:
            raise ValueError(
                "Project 203 CSV rows 與 reviewed plan 不一致："
                f"{project_203_report_result}"
            )
    except (OSError, json.JSONDecodeError, TypeError, KeyError, ValueError) as error:
        _add_check(
            checks,
            "project_203_manifest_contract",
            ok=False,
            expected={
                "manifest_schema_version": PROJECT_203_MANIFEST_SCHEMA_VERSION,
                "plan_schema_version": PROJECT_203_PLAN_SCHEMA_VERSION,
                "operation": PROJECT_203_OPERATION,
                "report_sha256": "valid_same_directory_csv",
                "review_plan_sha256": "valid",
                "apply_plan_sha256": "valid",
                "mode": "reviewed-apply",
                "overall_status": "complete",
                "database_status": "applied",
            },
            actual={"error": str(error)},
        )
        return _finalize_result(
            database_path,
            source_database_path,
            checks,
            organization_manifest_path,
            project_203_manifest_path,
        )
    repaired_project_id = int(project_203_plan["target_project_id"])
    replacement_work_slot_id = int(project_203_plan["target_work_slot_id"])
    with (
        _source_hash_guard(source_database_path, normalized_source_sha256),
        _suppress_audit_stop(),
        _read_only_connection(database_path) as target,
        _read_only_connection(source_database_path, immutable=True) as source,
    ):
        for label, connection in (("target", target), ("source", source)):
            integrity_rows = _integrity_rows(connection)
            _add_check(
                checks,
                f"{label}_integrity_check",
                ok=integrity_rows == ["ok"],
                expected=["ok"],
                actual=integrity_rows,
            )
            foreign_key_rows = _foreign_key_rows(connection)
            _add_check(
                checks,
                f"{label}_foreign_key_check",
                ok=not foreign_key_rows,
                expected=[],
                actual=foreign_key_rows[:20],
            )

        source_schema_errors = _schema_errors(source, SOURCE_REQUIRED_COLUMNS)
        target_schema_errors = _schema_errors(target, TARGET_REQUIRED_COLUMNS)
        _add_check(
            checks,
            "source_schema",
            ok=not any(source_schema_errors.values()),
            expected={"missing_tables": [], "missing_columns": {}},
            actual=source_schema_errors,
        )
        _add_check(
            checks,
            "target_schema",
            ok=not any(target_schema_errors.values()),
            expected={"missing_tables": [], "missing_columns": {}},
            actual=target_schema_errors,
        )
        if any(source_schema_errors.values()) or any(target_schema_errors.values()):
            raise _StopAudit

        source_table_preservation = _source_table_preservation(source, target)
        _add_check(
            checks,
            "source_immutable_tables_preserved",
            ok=bool(source_table_preservation["ok"]),
            expected={
                "allowed_mutable_source_tables": sorted(SOURCE_MUTABLE_TABLES),
                "missing_target_tables": [],
                "mismatched_tables": [],
            },
            actual=source_table_preservation,
        )

        try:
            organization_component_result = _organization_component_comparison(
                target,
                organization_plan,
                replacement_work_slot_id,
            )
        except (KeyError, TypeError, ValueError, sqlite3.DatabaseError) as error:
            organization_component_result = {
                "ok": False,
                "error": str(error),
            }
        _add_check(
            checks,
            "organization_manifest_applied_components",
            ok=bool(organization_component_result.get("ok")),
            expected={
                "reviewed_applied_components": "exact",
                "authorized_post_apply_delta": (
                    f"class_period_work_slots[{replacement_work_slot_id}].started_at"
                ),
                "mismatched_components": [],
            },
            actual=organization_component_result,
        )

        source_project_counts = _project_counts(source)
        target_project_counts = _project_counts(target)
        _add_check(
            checks,
            "source_project_counts",
            ok=source_project_counts == SOURCE_PROJECT_COUNTS,
            expected=SOURCE_PROJECT_COUNTS,
            actual=source_project_counts,
        )
        _add_check(
            checks,
            "target_project_counts",
            ok=target_project_counts == TARGET_PROJECT_COUNTS,
            expected=TARGET_PROJECT_COUNTS,
            actual=target_project_counts,
        )

        source_projects = _rows_by_id(
            source,
            "projects",
            SOURCE_PROJECT_COLUMNS,
        )
        target_projects = _rows_by_id(
            target,
            "projects",
            SOURCE_PROJECT_COLUMNS,
        )
        source_project_ids = set(source_projects)
        target_project_ids = set(target_projects)
        extra_project_ids = sorted(target_project_ids - source_project_ids)
        missing_project_ids = sorted(source_project_ids - target_project_ids)
        _add_check(
            checks,
            "existing_project_id_preservation",
            ok=not missing_project_ids and len(extra_project_ids) == 1,
            expected={"missing": [], "new_count": 1},
            actual={
                "missing": missing_project_ids,
                "new": extra_project_ids,
            },
        )
        project_content_mismatches = _content_mismatches(
            source_projects,
            target_projects,
            SOURCE_PROJECT_COLUMNS,
            mutable_columns_by_id={
                repaired_project_id: PROJECT_REPAIR_MUTABLE_COLUMNS,
            },
        )
        _add_check(
            checks,
            "existing_project_non_organization_content",
            ok=not project_content_mismatches,
            expected=[],
            actual=project_content_mismatches,
        )

        source_students = _rows_by_id(
            source,
            "students",
            SOURCE_STUDENT_COLUMNS,
        )
        target_students = _rows_by_id(
            target,
            "students",
            SOURCE_STUDENT_COLUMNS,
        )
        source_student_ids = set(source_students)
        target_student_ids = set(target_students)
        extra_student_ids = sorted(target_student_ids - source_student_ids)
        missing_student_ids = sorted(source_student_ids - target_student_ids)
        student_counts = {
            "source": len(source_students),
            "target": len(target_students),
            "new": len(extra_student_ids),
        }
        _add_check(
            checks,
            "student_counts_and_ids",
            ok=(
                student_counts == {
                    "source": SOURCE_STUDENT_COUNT,
                    "target": TARGET_STUDENT_COUNT,
                    "new": EXPECTED_REPLACEMENT_STUDENT_COUNT,
                }
                and not missing_student_ids
            ),
            expected={
                "source": SOURCE_STUDENT_COUNT,
                "target": TARGET_STUDENT_COUNT,
                "new": EXPECTED_REPLACEMENT_STUDENT_COUNT,
                "missing": [],
            },
            actual={**student_counts, "missing": missing_student_ids},
        )
        student_content_columns = tuple(
            column
            for column in SOURCE_STUDENT_COLUMNS
            if column not in STUDENT_ORGANIZATION_COLUMNS
        )
        student_content_mismatches = _content_mismatches(
            source_students,
            target_students,
            student_content_columns,
        )
        _add_check(
            checks,
            "existing_student_non_organization_content",
            ok=not student_content_mismatches,
            expected=[],
            actual=student_content_mismatches,
        )
        startup_project_values = [
            row
            for row in _rows(
                target,
                """SELECT id, created_by_id, created_by_name
                   FROM projects
                   WHERE created_by_id IS NOT NULL OR created_by_name IS NOT NULL
                   ORDER BY id""",
            )
            if int(row["id"]) in source_project_ids
        ]
        startup_student_values = [
            row
            for row in _rows(
                target,
                """SELECT id, album_name
                   FROM students WHERE album_name IS NOT NULL ORDER BY id""",
            )
            if int(row["id"]) in source_student_ids
        ]
        _add_check(
            checks,
            "existing_rows_startup_columns_remain_null",
            ok=not startup_project_values and not startup_student_values,
            expected={"projects": [], "students": []},
            actual={
                "projects": startup_project_values[:20],
                "students": startup_student_values[:20],
            },
        )

        project_198_student_ids = {
            student_id
            for student_id, row in source_students.items()
            if int(row["project_id"]) == 198
        }
        project_198_student_mismatches = [
            mismatch
            for mismatch in student_content_mismatches
            if mismatch.get("id") in project_198_student_ids
        ]
        project_198_project_mismatches = [
            mismatch
            for mismatch in project_content_mismatches
            if mismatch.get("id") == 198
        ]
        _add_check(
            checks,
            "project_198_latest_content_preserved",
            ok=(
                198 in source_projects
                and 198 in target_projects
                and not project_198_project_mismatches
                and not project_198_student_mismatches
            ),
            expected={"project_mismatches": [], "student_mismatches": []},
            actual={
                "project_mismatches": project_198_project_mismatches,
                "student_mismatches": project_198_student_mismatches,
                "student_count": len(project_198_student_ids),
            },
        )

        archived_states = []
        for project_id in ARCHIVED_PROJECT_IDS:
            source_row = source_projects.get(project_id)
            target_row = _one(
                target,
                """SELECT id, deleted_at, archive_expires_at, classroom_id,
                          class_period_work_slot_id
                   FROM projects WHERE id=?""",
                (project_id,),
            )
            archived_states.append({
                "id": project_id,
                "deleted_at": target_row and target_row["deleted_at"],
                "archive_expires_at": target_row and target_row["archive_expires_at"],
                "classroom_id": target_row and target_row["classroom_id"],
                "work_slot_id": target_row and target_row["class_period_work_slot_id"],
                "lifecycle_matches_source": bool(
                    source_row
                    and target_row
                    and target_row["deleted_at"] == source_row["deleted_at"]
                    and target_row["archive_expires_at"]
                    == source_row["archive_expires_at"]
                ),
            })
        archived_states_ok = all(
            row["deleted_at"] is not None
            and row["archive_expires_at"] is not None
            and row["classroom_id"] is None
            and row["work_slot_id"] is None
            and row["lifecycle_matches_source"]
            for row in archived_states
        )
        _add_check(
            checks,
            "projects_115_199_archived_unassigned",
            ok=archived_states_ok,
            expected="archived lifecycle preserved; classroom/work slot NULL",
            actual=archived_states,
        )

        source_203 = source_projects.get(repaired_project_id)
        target_203 = _one(
            target,
            """SELECT id, updated_at, deleted_at, archive_expires_at, classroom_id,
                      class_period_work_slot_id
               FROM projects WHERE id=?""",
            (repaired_project_id,),
        )
        source_203_student_count = sum(
            int(row["project_id"]) == repaired_project_id
            for row in source_students.values()
        )
        target_203_student_count = sum(
            int(row["project_id"]) == repaired_project_id
            for row in target_students.values()
        )
        deleted_at = _parse_datetime(target_203 and target_203["deleted_at"])
        archive_expires_at = _parse_datetime(
            target_203 and target_203["archive_expires_at"]
        )
        archive_window_ok = bool(
            deleted_at
            and archive_expires_at
            and archive_expires_at - deleted_at == timedelta(days=30)
        )
        project_203_ok = bool(
            source_203
            and source_203["deleted_at"] is None
            and source_203_student_count == 0
            and target_203
            and target_203["deleted_at"] is not None
            and target_203["classroom_id"] is None
            and target_203["class_period_work_slot_id"] is None
            and target_203_student_count == 0
            and archive_window_ok
        )
        _add_check(
            checks,
            "project_203_archived_zero_student",
            ok=project_203_ok,
            expected={
                "source_active_students": 0,
                "target_archived_students": 0,
                "unassigned": True,
                "archive_days": 30,
            },
            actual={
                "source_deleted_at": source_203 and source_203["deleted_at"],
                "source_students": source_203_student_count,
                "target": target_203,
                "target_students": target_203_student_count,
                "archive_window_days": (
                    (archive_expires_at - deleted_at).days
                    if deleted_at and archive_expires_at
                    else None
                ),
            },
        )

        active_replacement_slot_projects = _rows(
            target,
            """SELECT id, name, template_id, template_period_id,
                      template_revision, owner_id, label_texts_json, department,
                      completed_at, created_at, updated_at, deleted_at,
                      archive_expires_at, classroom_id,
                      class_period_work_slot_id, created_by_id, created_by_name,
                      campus_id_snapshot, campus_name_snapshot,
                      classroom_name_snapshot
               FROM projects
               WHERE class_period_work_slot_id=? AND deleted_at IS NULL
               ORDER BY id""",
            (replacement_work_slot_id,),
        )
        replacement_project_id = (
            int(active_replacement_slot_projects[0]["id"])
            if len(active_replacement_slot_projects) == 1
            else None
        )
        replacement_students = (
            _rows(
                target,
                """SELECT id, name, album_name, order_index, pages_data_json,
                          output_filename, created_at, updated_at, roster_child_id
                   FROM students WHERE project_id=? ORDER BY order_index, id""",
                (replacement_project_id,),
            )
            if replacement_project_id is not None
            else []
        )
        replacement_ok = bool(
            replacement_project_id is not None
            and extra_project_ids == [replacement_project_id]
            and replacement_project_id != repaired_project_id
            and len(replacement_students) == EXPECTED_REPLACEMENT_STUDENT_COUNT
            and {int(row["id"]) for row in replacement_students}
            == set(extra_student_ids)
        )
        _add_check(
            checks,
            "replacement_work_slot_unique_active_project",
            ok=replacement_ok,
            expected={"active_projects": 1, "new_project": True, "students": 8},
            actual={
                "projects": active_replacement_slot_projects,
                "replacement_student_count": len(replacement_students),
                "new_student_ids": extra_student_ids,
            },
        )
        replacement_project = (
            active_replacement_slot_projects[0]
            if replacement_project_id is not None
            else None
        )
        replacement_template = (
            _one(
                target,
                """SELECT template.id, template.name, template.revision,
                          template.period_id,
                          period.name AS period_name, period.department,
                          period.status
                   FROM templates AS template
                   JOIN template_periods AS period ON period.id=template.period_id
                   WHERE template.id=?""",
                (source_203["template_id"],),
            )
            if source_203 is not None
            else None
        )
        replacement_creator = (
            _one(
                target,
                "SELECT id, username, display_name, role FROM users WHERE id=?",
                (replacement_project["created_by_id"],),
            )
            if replacement_project is not None
            and replacement_project["created_by_id"] is not None
            else None
        )
        replacement_slot = _one(
            target,
            """SELECT slot.id, slot.term_classroom_id, slot.term_period_id,
                      slot.started_at, term_classroom.academic_term_id,
                      term_classroom.classroom_id,
                      term_classroom.campus_id_snapshot,
                      term_classroom.campus_name_snapshot,
                      term_classroom.classroom_name_snapshot,
                      term_classroom.department AS classroom_department,
                      term.label AS term_label, term.status AS term_status,
                      term_period.template_period_id,
                      term_period.period_name_snapshot,
                      term_period.department AS period_department,
                      classroom.name AS current_classroom_name,
                      classroom.department AS current_classroom_department,
                      classroom.is_active AS classroom_is_active,
                      campus.id AS current_campus_id,
                      campus.name AS current_campus_name,
                      campus.is_active AS campus_is_active
               FROM class_period_work_slots AS slot
               JOIN academic_term_classrooms AS term_classroom
                 ON term_classroom.id=slot.term_classroom_id
               JOIN academic_terms AS term
                 ON term.id=term_classroom.academic_term_id
               JOIN academic_term_periods AS term_period
                 ON term_period.id=slot.term_period_id
               JOIN classrooms AS classroom
                 ON classroom.id=term_classroom.classroom_id
               JOIN campuses AS campus ON campus.id=classroom.campus_id
               WHERE slot.id=?""",
            (replacement_work_slot_id,),
        )
        target_memberships = (
            _rows(
                target,
                """SELECT member.id AS membership_id,
                          member.roster_child_id,
                          child.name AS student_name
                   FROM class_roster_members AS member
                   JOIN roster_children AS child
                     ON child.id=member.roster_child_id
                   WHERE member.classroom_id=? AND member.ended_at IS NULL
                   ORDER BY member.started_at, member.id""",
                (replacement_slot["classroom_id"],),
            )
            if replacement_slot is not None
            else []
        )
        target_term_students = (
            _rows(
                target,
                """SELECT snapshot.id AS term_student_id,
                          snapshot.academic_term_id,
                          snapshot.source_membership_id,
                          snapshot.roster_child_id_snapshot AS roster_child_id,
                          snapshot.student_name_snapshot AS student_name
                   FROM academic_term_classroom_students AS snapshot
                   WHERE snapshot.term_classroom_id=?
                   ORDER BY snapshot.id""",
                (replacement_slot["term_classroom_id"],),
            )
            if replacement_slot is not None
            else []
        )
        replacement_metadata_ok = bool(
            replacement_project
            and source_203
            and replacement_template
            and replacement_creator
            and replacement_project["name"] == source_203["name"]
            and replacement_project["template_id"] == source_203["template_id"]
            and replacement_project["owner_id"] == source_203["owner_id"]
            and replacement_project["label_texts_json"]
            == source_203["label_texts_json"]
            and replacement_project["template_revision"]
            == replacement_template["revision"]
            and replacement_project["completed_at"] is None
            and replacement_project["deleted_at"] is None
            and replacement_project["archive_expires_at"] is None
            and replacement_creator["role"] == "admin"
            and replacement_project["created_by_name"]
            == replacement_creator["display_name"]
        )
        repair_timestamp = target_203 and target_203["deleted_at"]
        repair_timestamps = {
            "project_203_updated_at": target_203 and target_203["updated_at"],
            "project_203_deleted_at": repair_timestamp,
            "replacement_slot_started_at": (
                replacement_slot and replacement_slot["started_at"]
            ),
            "replacement_created_at": (
                replacement_project and replacement_project["created_at"]
            ),
            "replacement_updated_at": (
                replacement_project and replacement_project["updated_at"]
            ),
        }
        repair_timestamps_ok = bool(
            repair_timestamp
            and all(
                timestamp == repair_timestamp
                for timestamp in repair_timestamps.values()
            )
        )
        expected_replacement_album_names = _expected_automatic_album_names([
            str(student["name"]) for student in replacement_students
        ])
        actual_replacement_album_names = [
            student["album_name"] for student in replacement_students
        ]
        replacement_student_payload_ok = bool(
            replacement_project
            and len(replacement_students) == EXPECTED_REPLACEMENT_STUDENT_COUNT
            and actual_replacement_album_names
            == expected_replacement_album_names
            and all(
                student["pages_data_json"] == "[]"
                and student["output_filename"] is None
                and student["created_at"] == replacement_project["created_at"]
                and student["updated_at"] == replacement_project["updated_at"]
                for student in replacement_students
            )
        )
        project_203_manifest_database = (
            _project_203_manifest_database_comparison(
                project_203_manifest_value,
                project_203_plan,
                source_203,
                target_203,
                replacement_project,
                replacement_students,
                replacement_creator,
                replacement_slot,
                replacement_template,
                target_memberships,
                target_term_students,
            )
        )
        _add_check(
            checks,
            "project_203_replacement_metadata",
            ok=(
                replacement_metadata_ok
                and repair_timestamps_ok
                and replacement_student_payload_ok
                and bool(project_203_manifest_database.get("ok"))
            ),
            expected={
                "identity_fields_match_project_203": True,
                "template_revision_is_current": True,
                "created_by_role": "admin",
                "repair_timestamps_equal": True,
                "student_pages": "[]",
                "student_output_filename": None,
                "student_album_names": expected_replacement_album_names,
                "project_203_manifest_matches_database": True,
            },
            actual={
                "replacement": replacement_project,
                "template": replacement_template,
                "creator": replacement_creator,
                "timestamps": repair_timestamps,
                "student_payload_ok": replacement_student_payload_ok,
                "student_album_names": actual_replacement_album_names,
                "project_203_manifest": project_203_manifest_database,
            },
        )
        replacement_classroom_id = (
            int(active_replacement_slot_projects[0]["classroom_id"])
            if replacement_project_id is not None
            and active_replacement_slot_projects[0]["classroom_id"] is not None
            else None
        )
        current_classroom_roster = (
            _rows(
                target,
                """SELECT child.id AS roster_child_id, child.name
                   FROM class_roster_members AS member
                   JOIN roster_children AS child
                     ON child.id=member.roster_child_id
                   WHERE member.classroom_id=? AND member.ended_at IS NULL
                   ORDER BY child.id""",
                (replacement_classroom_id,),
            )
            if replacement_classroom_id is not None
            else []
        )
        replacement_identity = sorted(
            (int(row["roster_child_id"]), str(row["name"]))
            for row in replacement_students
            if row["roster_child_id"] is not None
        )
        roster_identity = sorted(
            (int(row["roster_child_id"]), str(row["name"]))
            for row in current_classroom_roster
        )
        expected_order_indexes = list(range(EXPECTED_REPLACEMENT_STUDENT_COUNT))
        actual_order_indexes = [int(row["order_index"]) for row in replacement_students]
        _add_check(
            checks,
            "replacement_project_matches_current_roster",
            ok=(
                replacement_identity == roster_identity
                and len(roster_identity) == EXPECTED_REPLACEMENT_STUDENT_COUNT
                and actual_order_indexes == expected_order_indexes
            ),
            expected={"roster_size": 8, "order_indexes": expected_order_indexes},
            actual={
                "replacement_identity": replacement_identity,
                "current_roster_identity": roster_identity,
                "order_indexes": actual_order_indexes,
            },
        )

        active_project_scope = _one(
            target,
            """SELECT COUNT(*) AS active,
                      SUM(classroom_id IS NULL) AS unassigned,
                      SUM(class_period_work_slot_id IS NULL) AS slotless
               FROM projects WHERE deleted_at IS NULL""",
        )
        active_scope_actual = {
            "active": int(active_project_scope["active"] or 0),
            "unassigned": int(active_project_scope["unassigned"] or 0),
            "slotless": int(active_project_scope["slotless"] or 0),
        } if active_project_scope else {}
        _add_check(
            checks,
            "active_projects_class_backed",
            ok=active_scope_actual == {"active": 74, "unassigned": 0, "slotless": 0},
            expected={"active": 74, "unassigned": 0, "slotless": 0},
            actual=active_scope_actual,
        )

        campus_counts = _one(
            target,
            """SELECT COUNT(*) AS total, SUM(is_active=1) AS active
               FROM campuses""",
        )
        classroom_counts = _one(
            target,
            """SELECT COUNT(*) AS total, SUM(is_active=1) AS active
               FROM classrooms""",
        )
        organization_counts = {
            "campuses": {
                "total": int(campus_counts["total"] or 0),
                "active": int(campus_counts["active"] or 0),
            } if campus_counts else {},
            "classrooms": {
                "total": int(classroom_counts["total"] or 0),
                "active": int(classroom_counts["active"] or 0),
            } if classroom_counts else {},
            "class_roster_members": _count_total_current(
                target,
                "class_roster_members",
            ),
            "classroom_teacher_assignments": _count_total_current(
                target,
                "classroom_teacher_assignments",
            ),
            "organization_supervisor_assignments": _count_total_current(
                target,
                "organization_supervisor_assignments",
            ),
        }
        expected_organization_counts = {
            "campuses": {"total": 3, "active": 3},
            "classrooms": {"total": 38, "active": 38},
            "class_roster_members": {"total": 466, "current": 465},
            "classroom_teacher_assignments": {"total": 52, "current": 52},
            "organization_supervisor_assignments": {"total": 10, "current": 10},
        }
        _add_check(
            checks,
            "organization_counts",
            ok=organization_counts == expected_organization_counts,
            expected=expected_organization_counts,
            actual=organization_counts,
        )
        try:
            historical_member_result = _reviewed_historical_roster_members(
                target,
                organization_plan,
            )
        except (KeyError, TypeError, ValueError, sqlite3.DatabaseError) as error:
            historical_member_result = {
                "ok": False,
                "error": str(error),
            }
        _add_check(
            checks,
            "historical_roster_member_matches_reviewed_plan",
            ok=bool(historical_member_result.get("ok")),
            expected={
                "count": 1,
                "reviewed_membership_and_child_name": "exact",
            },
            actual=historical_member_result,
        )

        orphan_children = _rows(
            target,
            """SELECT child.id, child.name
               FROM roster_children AS child
               WHERE NOT EXISTS (
                   SELECT 1 FROM students AS student
                   WHERE student.roster_child_id=child.id
               )
                 AND NOT EXISTS (
                   SELECT 1 FROM class_roster_members AS member
                   WHERE member.roster_child_id=child.id
               )
               ORDER BY child.id
               LIMIT 20""",
        )
        orphan_child_count = int(
            target.execute(
                """SELECT COUNT(*)
                   FROM roster_children AS child
                   WHERE NOT EXISTS (
                       SELECT 1 FROM students AS student
                       WHERE student.roster_child_id=child.id
                   )
                     AND NOT EXISTS (
                       SELECT 1 FROM class_roster_members AS member
                       WHERE member.roster_child_id=child.id
                   )"""
            ).fetchone()[0]
        )
        _add_check(
            checks,
            "orphan_roster_children",
            ok=orphan_child_count == 0,
            expected={"count": 0},
            actual={"count": orphan_child_count, "sample": orphan_children},
        )

        source_users = _rows_by_id(
            source,
            "users",
            (
                "id",
                "username",
                "hashed_password",
                "display_name",
                "role",
                "auth_version",
            ),
        )
        target_users = _rows_by_id(
            target,
            "users",
            (
                "id",
                "username",
                "hashed_password",
                "display_name",
                "role",
                "auth_version",
            ),
        )
        user_mismatches: list[dict[str, Any]] = []
        try:
            reviewed_user_updates = _reviewed_user_role_updates(
                organization_plan
            )
        except (KeyError, TypeError, ValueError) as error:
            reviewed_user_updates = {}
            user_mismatches.append({
                "error": "invalid_reviewed_user_updates",
                "detail": str(error),
            })
        if set(source_users) != set(target_users):
            user_mismatches.append({
                "missing": sorted(set(source_users) - set(target_users)),
                "new": sorted(set(target_users) - set(source_users)),
            })
        for user_id, source_user in source_users.items():
            target_user = target_users.get(user_id)
            if target_user is None:
                continue
            if (
                source_user["username"] != target_user["username"]
                or source_user["hashed_password"]
                != target_user["hashed_password"]
                or source_user["display_name"] != target_user["display_name"]
            ):
                changed_fields = [
                    field
                    for field in ("username", "hashed_password", "display_name")
                    if source_user[field] != target_user[field]
                ]
                user_mismatches.append({
                    "id": user_id,
                    "error": "identity_or_password_changed",
                    "fields": changed_fields,
                })
                continue
            source_auth_version = int(source_user["auth_version"] or 0)
            target_auth_version = int(target_user["auth_version"] or 0)
            reviewed_update = reviewed_user_updates.get(user_id)
            if reviewed_update is not None:
                if not (
                    source_user["display_name"]
                    == reviewed_update["display_name"]
                    and source_user["role"]
                    == reviewed_update["source_role"]
                    and source_auth_version
                    == reviewed_update["source_auth_version"]
                    and target_user["role"] == reviewed_update["role"]
                    and target_auth_version
                    == reviewed_update["auth_version"]
                ):
                    user_mismatches.append({
                        "id": user_id,
                        "source_role": source_user["role"],
                        "target_role": target_user["role"],
                        "source_auth_version": source_auth_version,
                        "target_auth_version": target_auth_version,
                    })
            elif not (
                source_user["role"] == target_user["role"]
                and source_auth_version == target_auth_version
            ):
                user_mismatches.append({
                    "id": user_id,
                    "error": "unexpected_access_change",
                    "source_role": source_user["role"],
                    "target_role": target_user["role"],
                    "source_auth_version": source_auth_version,
                    "target_auth_version": target_auth_version,
                })
            if len(user_mismatches) >= 20:
                break
        unknown_reviewed_user_ids = sorted(
            set(reviewed_user_updates) - set(source_users)
        )
        if unknown_reviewed_user_ids:
            user_mismatches.append({
                "error": "reviewed_users_missing_from_database",
                "ids": unknown_reviewed_user_ids,
            })
        role_counts = {
            str(row["role"]): int(row["count"])
            for row in _rows(
                target,
                "SELECT role, COUNT(*) AS count FROM users GROUP BY role",
            )
        }
        expected_role_counts = Counter(
            str(row["role"]) for row in source_users.values()
        )
        for reviewed_update in reviewed_user_updates.values():
            expected_role_counts[reviewed_update["source_role"]] -= 1
            expected_role_counts[reviewed_update["role"]] += 1
        expected_role_counts = Counter({
            role: count
            for role, count in expected_role_counts.items()
            if count
        })
        _add_check(
            checks,
            "user_roles_and_auth_versions",
            ok=(
                not user_mismatches
                and role_counts == dict(expected_role_counts)
            ),
            expected={
                "role_counts": dict(expected_role_counts),
                "reviewed_role_update_count": EXPECTED_ROLE_FIX_COUNT,
                "special_auth_delta": 1,
                "other_access_unchanged": True,
            },
            actual={"role_counts": role_counts, "mismatches": user_mismatches},
        )

        term_rows = _rows(
            target,
            """SELECT id, label, status, migration_key
               FROM academic_terms ORDER BY id""",
        )
        term_semantics = sorted(
            (str(row["label"]), str(row["status"])) for row in term_rows
        )
        expected_term_semantics = sorted([
            ("114下學期", "imported"),
            ("115上", "draft"),
        ])
        draft_plan_rows = _rows(
            target,
            """SELECT plan.id, plan.status, term.label AS term_label
               FROM term_reclassification_plans AS plan
               JOIN academic_terms AS term
                 ON term.id=plan.target_academic_term_id
               WHERE plan.status='draft'
               ORDER BY plan.id""",
        )
        term_ok = (
            term_semantics == expected_term_semantics
            and len(draft_plan_rows) == 1
            and draft_plan_rows[0]["term_label"] == "115上"
            and any(
                row["label"] == "114下學期"
                and row["migration_key"] == "organization-reporting-v1"
                for row in term_rows
            )
        )
        _add_check(
            checks,
            "academic_terms_114_115",
            ok=term_ok,
            expected={
                "terms": expected_term_semantics,
                "draft_plan_term": "115上",
            },
            actual={"terms": term_rows, "draft_plans": draft_plan_rows},
        )

        slot_rows = _rows(
            target,
            "SELECT id, started_at FROM class_period_work_slots ORDER BY id",
        )
        slot_states = {
            int(row["id"]): row["started_at"] is not None for row in slot_rows
        }
        reviewed_slot_rows = organization_plan["replacement_tables"][
            "class_period_work_slots"
        ]["rows"]
        expected_slot_states = {
            int(row["id"]): (
                row["started_at"] is not None
                or int(row["id"]) == replacement_work_slot_id
            )
            for row in reviewed_slot_rows
        }
        _add_check(
            checks,
            "work_slot_started_states",
            ok=slot_states == expected_slot_states,
            expected=expected_slot_states,
            actual=slot_states,
        )

        header_rows = _rows(
            target,
            """SELECT id, project_id_snapshot
               FROM legacy_project_classroom_migrations ORDER BY id""",
        )
        resolution_rows = _rows(
            target,
            """SELECT migration_id, project_id_snapshot, student_id_snapshot,
                      resolved_roster_child_id_snapshot
               FROM legacy_student_identity_resolutions
               ORDER BY id""",
        )
        expected_replay_project_ids = {
            project_id
            for project_id, row in source_projects.items()
            if row["deleted_at"] is None and project_id != repaired_project_id
        }
        actual_header_project_ids = {
            int(row["project_id_snapshot"]) for row in header_rows
        }
        expected_replay_student_pairs = {
            (int(row["project_id"]), student_id)
            for student_id, row in source_students.items()
            if int(row["project_id"]) in expected_replay_project_ids
        }
        organization_plan_coverage = _organization_plan_coverage(
            manifest_value,
            organization_plan,
            expected_replay_project_ids,
            expected_replay_student_pairs,
            repaired_project_id,
        )
        _add_check(
            checks,
            "organization_manifest_plan_coverage",
            ok=bool(organization_plan_coverage.get("ok")),
            expected={
                "replacement_tables": sorted(ORGANIZATION_REPLACEMENT_TABLES),
                "projects": 73,
                "students": 610,
                "ledger_headers": 73,
                "ledger_resolutions": 610,
                "user_update_count": EXPECTED_ROLE_FIX_COUNT,
                "legacy_teacher_links": 161,
                "component_hash_coverage": "complete",
            },
            actual=organization_plan_coverage,
        )
        actual_resolution_pairs = {
            (int(row["project_id_snapshot"]), int(row["student_id_snapshot"]))
            for row in resolution_rows
        }
        ledger_ok = (
            len(header_rows) == 73
            and len(actual_header_project_ids) == 73
            and actual_header_project_ids == expected_replay_project_ids
            and len(resolution_rows) == 610
            and len(actual_resolution_pairs) == 610
            and actual_resolution_pairs == expected_replay_student_pairs
        )
        _add_check(
            checks,
            "legacy_migration_ledgers",
            ok=ledger_ok,
            expected={"headers": 73, "resolutions": 610, "complete_coverage": True},
            actual={
                "headers": len(header_rows),
                "header_projects": len(actual_header_project_ids),
                "resolutions": len(resolution_rows),
                "resolution_pairs": len(actual_resolution_pairs),
                "missing_header_projects": sorted(
                    expected_replay_project_ids - actual_header_project_ids
                ),
                "extra_header_projects": sorted(
                    actual_header_project_ids - expected_replay_project_ids
                ),
                "missing_resolution_count": len(
                    expected_replay_student_pairs - actual_resolution_pairs
                ),
                "extra_resolution_count": len(
                    actual_resolution_pairs - expected_replay_student_pairs
                ),
            },
        )

        resolutions_by_student = {
            int(row["student_id_snapshot"]): int(
                row["resolved_roster_child_id_snapshot"]
            )
            for row in resolution_rows
        }
        roster_link_mismatches = []
        for student_id, source_student in source_students.items():
            target_student = target_students.get(student_id)
            if target_student is None:
                continue
            project_id = int(source_student["project_id"])
            if project_id in expected_replay_project_ids:
                expected_roster_child_id = resolutions_by_student.get(student_id)
            else:
                expected_roster_child_id = source_student["roster_child_id"]
            if target_student["roster_child_id"] != expected_roster_child_id:
                roster_link_mismatches.append({
                    "student_id": student_id,
                    "project_id": project_id,
                    "source": source_student["roster_child_id"],
                    "expected": expected_roster_child_id,
                    "target": target_student["roster_child_id"],
                })
                if len(roster_link_mismatches) >= 20:
                    break
        _add_check(
            checks,
            "student_roster_links_follow_resolution_ledger_only",
            ok=not roster_link_mismatches,
            expected={
                "replay_students": 610,
                "all_other_existing_links": "source preserved",
            },
            actual={"mismatches": roster_link_mismatches},
        )

        archived_link_mismatches = [
            {
                "student_id": student_id,
                "project_id": int(source_student["project_id"]),
                "source": source_student["roster_child_id"],
                "target": target_students.get(student_id, {}).get("roster_child_id"),
            }
            for student_id, source_student in source_students.items()
            if int(source_student["project_id"]) in ARCHIVED_PROJECT_IDS
            and target_students.get(student_id, {}).get("roster_child_id")
            != source_student["roster_child_id"]
        ]
        _add_check(
            checks,
            "archived_project_student_links_preserved",
            ok=not archived_link_mismatches,
            expected=[],
            actual=archived_link_mismatches,
        )

        identity_anomalies = _rows(
            target,
            """SELECT slot.term_period_id, student.roster_child_id,
                      COUNT(*) AS appearances,
                      GROUP_CONCAT(project.id) AS project_ids
               FROM projects AS project
               JOIN class_period_work_slots AS slot
                 ON slot.id=project.class_period_work_slot_id
               JOIN students AS student ON student.project_id=project.id
               WHERE project.deleted_at IS NULL
               GROUP BY slot.term_period_id, student.roster_child_id
               HAVING student.roster_child_id IS NULL OR COUNT(*) > 1
               ORDER BY slot.term_period_id, student.roster_child_id
               LIMIT 20""",
        )
        _add_check(
            checks,
            "active_student_period_identity_unique",
            ok=not identity_anomalies,
            expected=[],
            actual=identity_anomalies,
        )

    source_sha256_after = _file_sha256(source_database_path)
    _add_check(
        checks,
        "source_database_sha256",
        ok=(
            source_sha256_before
            == source_sha256_after
            == normalized_source_sha256
        ),
        expected={
            "before_open": normalized_source_sha256,
            "after_close": normalized_source_sha256,
        },
        actual={
            "before_open": source_sha256_before,
            "after_close": source_sha256_after,
        },
    )
    return _finalize_result(
        database_path,
        source_database_path,
        checks,
        organization_manifest_path,
        project_203_manifest_path,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--source-db", type=Path, required=True)
    parser.add_argument("--source-sha256", type=_normalized_sha256, required=True)
    parser.add_argument("--organization-manifest", type=Path, required=True)
    parser.add_argument("--project-203-manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    database_path = arguments.db.resolve()
    source_database_path = arguments.source_db.resolve()
    organization_manifest_path = arguments.organization_manifest.resolve()
    project_203_manifest_path = arguments.project_203_manifest.resolve()
    output_path = arguments.output.resolve() if arguments.output else None
    missing_paths = [
        str(path)
        for path in (
            database_path,
            source_database_path,
            organization_manifest_path,
            project_203_manifest_path,
        )
        if not path.is_file()
    ]
    if missing_paths:
        print(
            "錯誤：找不到必要檔案 " + "、".join(missing_paths),
            file=sys.stderr,
        )
        return 2
    if output_path is not None:
        if output_path.suffix.lower() != ".json":
            print("錯誤：--output 必須是 .json 檔案", file=sys.stderr)
            return 2
        if not output_path.parent.is_dir():
            print("錯誤：--output 父目錄不存在", file=sys.stderr)
            return 2
        protected_paths = {
            database_path,
            source_database_path,
            organization_manifest_path,
            project_203_manifest_path,
        }
        if output_path in protected_paths:
            print("錯誤：--output 不可覆寫輸入檔案", file=sys.stderr)
            return 2
    try:
        result = audit_production_migration(
            database_path,
            source_database_path,
            arguments.source_sha256,
            organization_manifest_path,
            project_203_manifest_path,
        )
    except (OSError, sqlite3.DatabaseError, ValueError) as error:
        result = _finalize_result(
            database_path,
            source_database_path,
            [{
                "name": "audit_execution",
                "ok": False,
                "expected": "audit completed",
                "actual": str(error),
            }],
            organization_manifest_path,
            project_203_manifest_path,
        )
    if output_path is not None:
        result["output"] = str(output_path)
        try:
            write_manifest(output_path, result)
        except OSError as error:
            print(json.dumps(_terminal_summary(result), ensure_ascii=False, indent=2))
            print(f"錯誤：無法原子寫入 --output：{error}", file=sys.stderr)
            return 2
    print(json.dumps(_terminal_summary(result), ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
