"""把 2026-07 正式資料的園所／學期結構從已審 reference 快照重播到最新 DB。

預設只產生含固定資料計畫的 manifest；正式套用只能讀同一份 manifest，並要求
maintenance window 與計畫 SHA-256 acknowledgement。manifest 含師生姓名，必須
留在已由 gitignore 排除的 ``output/``，不可提交。

``--reference-db`` 只接受本次 release 已凍結 artifact 的精確 SHA-256；不能以另一份
語意相似的 DB、重新匯出的副本或人工 acknowledgement 取代 provenance 驗證。
"""

from __future__ import annotations

import argparse
import copy
import errno
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.data_script_utils import (  # noqa: E402
    generate_run_id,
    layout_sha256,
    run_scoped_path,
    utc_now_iso,
    validate_run_id,
    write_manifest,
)


OPERATION = "migrate_production_organization_202607"
PLAN_SCHEMA_VERSION = 4
MANIFEST_SCHEMA_VERSION = 1
EXCLUDED_PROJECT_ID = 203
REQUIRED_ARCHIVED_PROJECT_IDS = (115, 199)
# 取自 13:59:07Z 正式 source backup（DB SHA-256
# da8b3bc719db27e5f645255ac2ed278126a710843fec33a6760fc5c5d3f013b0）與
# frozen reference（SHA-256 b753b3aec0b0f03e151d9a5ce88f6eb54770b5f58e278cdd4ebd5e06c42eaf15）
# 產生的 reviewed identity set。
# 兩個 SHA 都直接對排序後的 JSON list 使用 separators=(",", ":") 計算；
# 第二份 list 的每個元素固定為 [student_id, project_id]，避免同數量 swap 通過。
EXPECTED_REPLAY_PROJECT_COUNT = 73
EXPECTED_REPLAY_STUDENT_COUNT = 610
EXPECTED_REPLAY_PROJECT_IDS_SHA256 = (
    "fdc7257a2f6e99c9ff7d9ba85e19fca270f8de8c7a0b41db351ed21772244dc3"
)
EXPECTED_REPLAY_STUDENT_PROJECT_PAIRS_SHA256 = (
    "fdbcb881bb26865700fab21686bb7ef43596547b6f07d7f15c762a4e25cad94b"
)
EXPECTED_USER_ROLE_UPDATE_COUNT = 3
EXPECTED_REFERENCE_COUNTS = {
    "class_roster_members": {"total": 466, "current": 465},
    "classroom_teacher_assignments": {"total": 52, "current": 52},
    "organization_supervisor_assignments": {"total": 10, "current": 10},
}
RELEASE_REFERENCE_DATABASE_SHA256 = (
    "b753b3aec0b0f03e151d9a5ce88f6eb54770b5f58e278cdd4ebd5e06c42eaf15"
)
EXPECTED_LEGACY_TEACHER_LINK_COUNT = 161
LEGACY_TEACHER_LINK_SEMANTIC_COLUMNS = (
    "teacher_id",
    "supervisor_id",
    "teacher_name_snapshot",
    "supervisor_name_snapshot",
)
EXPECTED_ROSTER_CHILD_FOREIGN_KEYS = {
    ("class_roster_members", "roster_child_id"),
    ("students", "roster_child_id"),
}
DEFAULT_MANIFEST_BASE = (
    ROOT_DIR / "output" / "production-organization-202607.manifest.json"
)

REPLACEMENT_TABLES = (
    "campuses",
    "classrooms",
    "class_roster_members",
    "classroom_teacher_assignments",
    "organization_supervisor_assignments",
    "academic_terms",
    "academic_term_periods",
    "academic_term_classrooms",
    "academic_term_classroom_teachers",
    "academic_term_classroom_students",
    "class_period_work_slots",
    "term_reclassification_plans",
    "term_student_placements",
    "term_classroom_plans",
    "term_classroom_teacher_targets",
)
DELETE_TABLE_ORDER = tuple(reversed(REPLACEMENT_TABLES))
LEDGER_TABLES = (
    "legacy_project_classroom_migrations",
    "legacy_student_identity_resolutions",
)
SCHEMA_TABLES = (
    "users",
    "template_periods",
    "templates",
    "projects",
    "students",
    "roster_children",
    "legacy_teacher_supervisor_links",
    *REPLACEMENT_TABLES,
    *LEDGER_TABLES,
)
REFERENCE_REQUIRED_TRIGGERS = (
    "trg_academic_term_students_freeze_delete",
    "trg_academic_term_students_freeze_insert",
    "trg_academic_term_students_freeze_update",
    "trg_academic_term_students_match_term_insert",
    "trg_academic_term_students_match_term_update",
    "trg_legacy_project_migrations_no_delete",
    "trg_legacy_project_migrations_no_update",
    "trg_legacy_student_resolutions_no_delete",
    "trg_legacy_student_resolutions_no_update",
    "trg_projects_freeze_assigned_classroom",
    "trg_projects_freeze_classroom_snapshots",
    "trg_projects_freeze_work_slot",
    "trg_projects_require_identity_migration_ledger",
    "trg_students_freeze_class_backed_identity",
    "trg_work_slots_freeze_identity",
    "trg_work_slots_freeze_started_at",
)
REQUIRED_TRIGGERS = (
    *REFERENCE_REQUIRED_TRIGGERS,
    "trg_projects_reject_empty_identity_migration",
)
PROJECT_ORGANIZATION_COLUMNS = (
    "classroom_id",
    "class_period_work_slot_id",
    "campus_id_snapshot",
    "campus_name_snapshot",
    "classroom_name_snapshot",
)
SOURCE_GUARD_USER_COLUMNS = (
    "id",
    "username",
    "display_name",
    "role",
    "auth_version",
)
SOURCE_GUARD_PERIOD_COLUMNS = (
    "id",
    "name",
    "department",
    "status",
)
SOURCE_GUARD_TEMPLATE_COLUMNS = (
    "id",
    "name",
    "period_id",
    "revision",
)
SOURCE_GUARD_PROJECT_COLUMNS = (
    "id",
    "name",
    "template_id",
    "department",
    "template_period_id",
    "owner_id",
    "created_at",
    "deleted_at",
    "archive_expires_at",
    *PROJECT_ORGANIZATION_COLUMNS,
)
SOURCE_GUARD_STUDENT_COLUMNS = (
    "id",
    "project_id",
    "name",
    "order_index",
    "created_at",
)
SOURCE_GUARD_CHILD_COLUMNS = ("id", "name", "created_at")
STATE_IGNORED_COLUMNS = {
    # startup migration 每台機器會在不同時間建立 imported term。
    "academic_terms": {"created_at"},
}


class ApplyPreflightError(RuntimeError):
    """套用前 schema 或來源資料已漂移。"""


class ApplyReconciliationError(RuntimeError):
    """crash-gap 狀態不是完整未套用或完整已套用。"""

    def __init__(self, message: str, *, database_state: str):
        super().__init__(message)
        self.database_state = database_state


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_identity_sha256(value: list[Any]) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _reviewed_replay_identity_summary(
    project_ids: list[int],
    student_project_pairs: list[list[int]],
) -> dict[str, Any]:
    normalized_project_ids = sorted(int(project_id) for project_id in project_ids)
    normalized_student_pairs = sorted(
        [int(pair[0]), int(pair[1])] for pair in student_project_pairs
    )
    return {
        "project_count": len(normalized_project_ids),
        "student_count": len(normalized_student_pairs),
        "project_ids_sha256": _canonical_identity_sha256(
            normalized_project_ids
        ),
        "student_project_pairs_sha256": _canonical_identity_sha256(
            normalized_student_pairs
        ),
    }


def _validate_reviewed_replay_identity(
    project_ids: list[int],
    student_project_pairs: list[list[int]],
) -> dict[str, Any]:
    summary = _reviewed_replay_identity_summary(
        project_ids,
        student_project_pairs,
    )
    expected = {
        "project_count": EXPECTED_REPLAY_PROJECT_COUNT,
        "student_count": EXPECTED_REPLAY_STUDENT_COUNT,
        "project_ids_sha256": EXPECTED_REPLAY_PROJECT_IDS_SHA256,
        "student_project_pairs_sha256": (
            EXPECTED_REPLAY_STUDENT_PROJECT_PAIRS_SHA256
        ),
    }
    if summary != expected:
        raise ValueError(
            "正式 reviewed replay identity 不符："
            f"actual={summary} expected={expected}"
        )
    return summary


def _current_replay_identity(
    connection: sqlite3.Connection,
) -> tuple[list[int], list[list[int]]]:
    project_ids = [
        int(row[0])
        for row in connection.execute(
            "SELECT id FROM projects "
            "WHERE deleted_at IS NULL AND id <> ? ORDER BY id",
            (EXCLUDED_PROJECT_ID,),
        )
    ]
    student_rows = _rows_for_ids(
        connection,
        "students",
        "project_id",
        project_ids,
        columns=("id", "project_id"),
    )
    student_project_pairs = sorted(
        [int(row["id"]), int(row["project_id"])]
        for row in student_rows
    )
    return project_ids, student_project_pairs


def _validate_plan_replay_identity(plan: dict[str, Any]) -> None:
    try:
        project_ids = sorted(
            int(value) for value in plan["replay_project_ids"]
        )
        student_project_pairs = sorted(
            [int(row["id"]), int(row["project_id"])]
            for row in plan["student_updates"]
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("review plan 缺少合法 replay identity") from error
    summary = _validate_reviewed_replay_identity(
        project_ids,
        student_project_pairs,
    )
    if plan.get("reviewed_replay_identity") != summary:
        raise ValueError("review plan 的固定 replay identity 摘要不符")
    analysis = plan.get("analysis")
    if not isinstance(analysis, dict) or (
        analysis.get("replay_project_count") != EXPECTED_REPLAY_PROJECT_COUNT
        or analysis.get("replay_student_count") != EXPECTED_REPLAY_STUDENT_COUNT
    ):
        raise ValueError("review plan 的 replay identity 數量不符")
    _excluded_project_work_slot_id(plan)


def _excluded_project_work_slot_id(plan: dict[str, Any]) -> int:
    work_slot_id = plan.get("excluded_project_work_slot_id")
    if not isinstance(work_slot_id, int) or isinstance(work_slot_id, bool):
        raise ValueError("review plan 缺少 excluded Project 工作格")
    slot_rows = plan.get("replacement_tables", {}).get(
        "class_period_work_slots", {}
    ).get("rows", [])
    matching_slots = [
        row for row in slot_rows if row.get("id") == work_slot_id
    ]
    if len(matching_slots) != 1 or matching_slots[0].get("started_at") is not None:
        raise ValueError("review plan 的 excluded Project 工作格不合法")
    return work_slot_id


def _validate_release_reference_artifact(reference_database_path: Path) -> str:
    """只接受本次 release 已凍結且逐位元一致的 reference artifact。"""
    for suffix in ("-wal", "-shm"):
        sidecar_path = reference_database_path.with_name(
            reference_database_path.name + suffix
        )
        if sidecar_path.exists():
            raise ValueError(
                "reference DB 不可帶 SQLite sidecar："
                f"{sidecar_path.name}"
            )
    actual_sha256 = _file_sha256(reference_database_path)
    if actual_sha256 != RELEASE_REFERENCE_DATABASE_SHA256:
        raise ValueError(
            "reference DB 不是本次 release artifact："
            f"預期 SHA-256 {RELEASE_REFERENCE_DATABASE_SHA256}，"
            f"實際 {actual_sha256}"
        )
    return actual_sha256


def _quote_identifier(identifier: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", identifier):
        raise ValueError(f"不安全的 SQLite identifier：{identifier}")
    return f'"{identifier}"'


def _connect(
    database_path: Path,
    *,
    read_only: bool = False,
) -> sqlite3.Connection:
    if read_only:
        connection = sqlite3.connect(
            f"{database_path.resolve().as_uri()}?mode=ro&immutable=1",
            uri=True,
        )
        connection.execute("PRAGMA query_only=ON")
    else:
        connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _table_columns(connection: sqlite3.Connection, table_name: str) -> list[str]:
    return [
        str(row["name"])
        for row in connection.execute(
            f"PRAGMA table_info({_quote_identifier(table_name)})"
        )
    ]


def _rows(
    connection: sqlite3.Connection,
    table_name: str,
    *,
    columns: tuple[str, ...] | list[str] | None = None,
    where_sql: str = "",
    parameters: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    selected_columns = list(columns or _table_columns(connection, table_name))
    if not selected_columns:
        raise ValueError(f"找不到資料表 {table_name}")
    column_sql = ", ".join(_quote_identifier(column) for column in selected_columns)
    query = f"SELECT {column_sql} FROM {_quote_identifier(table_name)}"
    if where_sql:
        query += f" WHERE {where_sql}"
    if "id" in selected_columns:
        query += " ORDER BY id"
    return [dict(row) for row in connection.execute(query, parameters)]


def _rows_for_ids(
    connection: sqlite3.Connection,
    table_name: str,
    id_column: str,
    identifiers: list[int],
    *,
    columns: tuple[str, ...] | list[str] | None = None,
) -> list[dict[str, Any]]:
    if not identifiers:
        return []
    placeholders = ",".join("?" for _identifier in identifiers)
    return _rows(
        connection,
        table_name,
        columns=columns,
        where_sql=f"{_quote_identifier(id_column)} IN ({placeholders})",
        parameters=tuple(identifiers),
    )


def _schema_contract(
    connection: sqlite3.Connection,
    *,
    required_triggers: tuple[str, ...] = REQUIRED_TRIGGERS,
) -> dict[str, Any]:
    tables: dict[str, Any] = {}
    for table_name in SCHEMA_TABLES:
        table_exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (table_name,),
        ).fetchone()
        if table_exists is None:
            raise ValueError(f"資料庫尚未完成 startup migrations：缺少 {table_name}")
        # cid、FK id 與 PRAGMA 列舉順序會因新建或逐次 migration
        # 不同；manifest 只鎖定目標語意 schema，不鎖定這些實作序號。
        table_info = sorted(
            (
                {
                    "name": str(row["name"]),
                    "type": str(row["type"]),
                    "not_null": bool(row["notnull"]),
                    "default": row["dflt_value"],
                    "primary_key_position": int(row["pk"]),
                }
                for row in connection.execute(
                    f"PRAGMA table_info({_quote_identifier(table_name)})"
                )
            ),
            key=lambda item: item["name"],
        )
        foreign_keys = sorted(
            (
                {
                    "from": str(row["from"]),
                    "table": str(row["table"]),
                    "to": str(row["to"]),
                    "on_update": str(row["on_update"]),
                    "on_delete": str(row["on_delete"]),
                    "match": str(row["match"]),
                }
                for row in connection.execute(
                    f"PRAGMA foreign_key_list({_quote_identifier(table_name)})"
                )
            ),
            key=lambda item: (
                item["from"],
                item["table"],
                item["to"],
                item["on_update"],
                item["on_delete"],
                item["match"],
            ),
        )
        indexes = []
        for index_row in connection.execute(
            f"PRAGMA index_list({_quote_identifier(table_name)})"
        ):
            index_name = str(index_row[1])
            indexes.append({
                "name": index_name,
                "unique": bool(index_row[2]),
                "origin": str(index_row[3]),
                "partial": bool(index_row[4]),
                "columns": [
                    str(column_row[2])
                    for column_row in connection.execute(
                        f"PRAGMA index_info({_quote_identifier(index_name)})"
                    )
                ],
            })
        indexes.sort(key=lambda item: item["name"])
        tables[table_name] = {
            "table_info": table_info,
            "foreign_keys": foreign_keys,
            "indexes": indexes,
        }
    trigger_names = sorted(
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='trigger'"
        )
        if row[0] in required_triggers
    )
    if trigger_names != sorted(required_triggers):
        missing = sorted(set(required_triggers) - set(trigger_names))
        raise ValueError(f"資料庫缺少 migration triggers：{missing}")
    return {"tables": tables, "required_triggers": trigger_names}


def _validate_reference_schema(
    reference: sqlite3.Connection,
    target: sqlite3.Connection,
) -> None:
    """reference 可來自逐次 migration，但必須能以 target 欄位名重播。"""
    # 仍要求 reference 已跑完所有必要表與保護 triggers。
    _schema_contract(
        reference,
        required_triggers=REFERENCE_REQUIRED_TRIGGERS,
    )
    for table_name in SCHEMA_TABLES:
        target_columns = set(_table_columns(target, table_name))
        reference_columns = set(_table_columns(reference, table_name))
        missing_columns = sorted(target_columns - reference_columns)
        if missing_columns:
            raise ValueError(
                f"reference {table_name} 缺少 target 欄位：{missing_columns}"
            )


def _foreign_key_errors(connection: sqlite3.Connection) -> list[list[Any]]:
    return [list(row) for row in connection.execute("PRAGMA foreign_key_check")]


def _validate_roster_child_reference_contract(
    connection: sqlite3.Connection,
) -> None:
    actual_references: set[tuple[str, str]] = set()
    table_names = [
        str(row[0])
        for row in connection.execute(
            """SELECT name FROM sqlite_master
               WHERE type='table' AND name NOT LIKE 'sqlite_%'"""
        )
    ]
    for table_name in table_names:
        for foreign_key in connection.execute(
            f"PRAGMA foreign_key_list({_quote_identifier(table_name)})"
        ):
            if str(foreign_key["table"]) == "roster_children":
                actual_references.add((table_name, str(foreign_key["from"])))
    if actual_references != EXPECTED_ROSTER_CHILD_FOREIGN_KEYS:
        raise ValueError(
            "RosterChild FK 使用者已漂移："
            f"{sorted(actual_references)}"
        )


def _source_guard(
    connection: sqlite3.Connection,
    replay_project_ids: list[int],
) -> dict[str, Any]:
    guarded_project_ids = sorted(
        set(replay_project_ids)
        | {EXCLUDED_PROJECT_ID}
        | set(REQUIRED_ARCHIVED_PROJECT_IDS)
    )
    replay_students = _rows_for_ids(
        connection,
        "students",
        "project_id",
        replay_project_ids,
        columns=SOURCE_GUARD_STUDENT_COLUMNS,
    )
    relevant_template_ids = sorted({
        int(row["template_id"])
        for row in _rows_for_ids(
            connection,
            "projects",
            "id",
            guarded_project_ids,
            columns=("id", "template_id"),
        )
    })
    return {
        "users": _rows(
            connection,
            "users",
            columns=SOURCE_GUARD_USER_COLUMNS,
        ),
        "template_periods": _rows(
            connection,
            "template_periods",
            columns=SOURCE_GUARD_PERIOD_COLUMNS,
        ),
        "templates": _rows_for_ids(
            connection,
            "templates",
            "id",
            relevant_template_ids,
            columns=SOURCE_GUARD_TEMPLATE_COLUMNS,
        ),
        "projects": _rows_for_ids(
            connection,
            "projects",
            "id",
            guarded_project_ids,
            columns=SOURCE_GUARD_PROJECT_COLUMNS,
        ),
        "students": replay_students,
        "existing_roster_children": _rows(
            connection,
            "roster_children",
            columns=SOURCE_GUARD_CHILD_COLUMNS,
        ),
    }


def _normalized_table_rows(
    table_name: str,
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    ignored_columns = STATE_IGNORED_COLUMNS.get(table_name, set())
    return [
        {
            column: value
            for column, value in row.items()
            if column not in ignored_columns
        }
        for row in rows
    ]


def _component_hash(value: Any) -> str:
    return layout_sha256({"value": value})


def _state_component_values(
    connection: sqlite3.Connection,
    plan: dict[str, Any],
) -> dict[str, Any]:
    components: dict[str, Any] = {}
    for table_name, table_plan in plan["replacement_tables"].items():
        current_rows = _rows(
            connection,
            table_name,
            columns=table_plan["columns"],
        )
        components[f"table:{table_name}"] = _normalized_table_rows(
            table_name,
            current_rows,
        )
    child_rows = plan["roster_children_to_insert"]["rows"]
    child_ids = [int(row["id"]) for row in child_rows]
    components["roster_children_to_insert"] = _rows_for_ids(
        connection,
        "roster_children",
        "id",
        child_ids,
        columns=plan["roster_children_to_insert"]["columns"],
    )
    deleted_child_rows = plan["roster_children_to_delete"]["rows"]
    deleted_child_ids = [int(row["id"]) for row in deleted_child_rows]
    components["roster_children_to_delete"] = _rows_for_ids(
        connection,
        "roster_children",
        "id",
        deleted_child_ids,
        columns=plan["roster_children_to_delete"]["columns"],
    )
    project_ids = [int(row["id"]) for row in plan["project_updates"]]
    components["project_organization"] = _rows_for_ids(
        connection,
        "projects",
        "id",
        project_ids,
        columns=("id", "deleted_at", *PROJECT_ORGANIZATION_COLUMNS),
    )
    student_ids = [int(row["id"]) for row in plan["student_updates"]]
    components["student_identity"] = _rows_for_ids(
        connection,
        "students",
        "id",
        student_ids,
        columns=("id", "project_id", "roster_child_id"),
    )
    for table_name in LEDGER_TABLES:
        table_plan = plan["ledger_rows"][table_name]
        components[f"ledger:{table_name}"] = _rows(
            connection,
            table_name,
            columns=table_plan["columns"],
        )
    user_ids = [int(row["id"]) for row in plan["user_updates"]]
    components["user_access_roles"] = _rows_for_ids(
        connection,
        "users",
        "id",
        user_ids,
        columns=("id", "role", "auth_version"),
    )
    components["legacy_teacher_supervisor_links"] = (
        _legacy_teacher_link_semantics(connection)
    )
    return components


def _state_component_hashes(values: dict[str, Any]) -> dict[str, str]:
    return {
        component_name: _component_hash(component_value)
        for component_name, component_value in sorted(values.items())
    }


def _planned_applied_component_values(plan: dict[str, Any]) -> dict[str, Any]:
    components: dict[str, Any] = {}
    for table_name, table_plan in plan["replacement_tables"].items():
        components[f"table:{table_name}"] = _normalized_table_rows(
            table_name,
            table_plan["rows"],
        )
    components["roster_children_to_insert"] = plan[
        "roster_children_to_insert"
    ]["rows"]
    components["roster_children_to_delete"] = []
    components["project_organization"] = [
        {
            "id": row["id"],
            "deleted_at": None,
            **{
                column: row[column]
                for column in PROJECT_ORGANIZATION_COLUMNS
            },
        }
        for row in plan["project_updates"]
    ]
    components["student_identity"] = [
        {
            "id": row["id"],
            "project_id": row["project_id"],
            "roster_child_id": row["roster_child_id"],
        }
        for row in plan["student_updates"]
    ]
    for table_name in LEDGER_TABLES:
        components[f"ledger:{table_name}"] = plan["ledger_rows"][table_name][
            "rows"
        ]
    components["user_access_roles"] = [
        {
            "id": row["id"],
            "role": row["role"],
            "auth_version": row["auth_version"],
        }
        for row in plan["user_updates"]
    ]
    components["legacy_teacher_supervisor_links"] = plan[
        "preserved_legacy_teacher_supervisor_links"
    ]["rows"]
    return components


def _classify_database_state(
    connection: sqlite3.Connection,
    plan: dict[str, Any],
) -> str:
    current_components = _state_component_values(connection, plan)
    current_hashes = _state_component_hashes(current_components)
    source_hashes = plan["source_state_component_sha256"]
    applied_hashes = plan["applied_state_component_sha256"]
    if current_hashes == applied_hashes:
        return "applied"
    if current_hashes == source_hashes:
        return "not_applied"

    # excluded Project 修復是 organization replay 唯一允許的 downstream 變更：
    # 它只會把 private plan 指定工作格的 started_at 由 NULL 設為套用時間。先在副本
    # 正規化回 reviewed 值，再要求所有 applied component hash 完全一致；因此
    # 其他 row、column 或 component 的任何漂移仍會被拒絕。
    normalized_components = copy.deepcopy(current_components)
    excluded_work_slot_id = _excluded_project_work_slot_id(plan)
    slot_component_name = "table:class_period_work_slots"
    current_slot_rows = normalized_components.get(slot_component_name)
    reviewed_slot_rows = _planned_applied_component_values(plan).get(
        slot_component_name
    )
    if isinstance(current_slot_rows, list) and isinstance(
        reviewed_slot_rows, list
    ):
        current_excluded_slot = [
            row
            for row in current_slot_rows
            if int(row.get("id", -1)) == excluded_work_slot_id
        ]
        reviewed_excluded_slot = [
            row
            for row in reviewed_slot_rows
            if int(row.get("id", -1)) == excluded_work_slot_id
        ]
        if (
            len(current_excluded_slot) == 1
            and len(reviewed_excluded_slot) == 1
            and current_excluded_slot[0].get("started_at") is not None
            and reviewed_excluded_slot[0].get("started_at") is None
        ):
            current_excluded_slot[0]["started_at"] = None
            if _state_component_hashes(normalized_components) == applied_hashes:
                return "applied"

    component_states = []
    for component_name, current_hash in current_hashes.items():
        if current_hash == source_hashes.get(component_name):
            component_states.append("not_applied")
        elif current_hash == applied_hashes.get(component_name):
            component_states.append("applied")
        else:
            return "diverged"
    if "applied" in component_states and "not_applied" in component_states:
        return "mixed"
    return "diverged"


def _table_payload(
    connection: sqlite3.Connection,
    table_name: str,
    *,
    columns: list[str] | None = None,
) -> dict[str, Any]:
    selected_columns = columns or _table_columns(connection, table_name)
    return {
        "columns": selected_columns,
        "rows": _rows(connection, table_name, columns=selected_columns),
    }


def _validate_target_baseline(connection: sqlite3.Connection) -> list[int]:
    if _foreign_key_errors(connection):
        raise ValueError("target DB 在 replay 前已有 foreign key errors")
    for table_name in (
        "campuses",
        "classrooms",
        "class_roster_members",
        "classroom_teacher_assignments",
        "organization_supervisor_assignments",
        "academic_term_classrooms",
        "academic_term_classroom_teachers",
        "academic_term_classroom_students",
        "class_period_work_slots",
        "term_reclassification_plans",
        "term_student_placements",
        "term_classroom_plans",
        "term_classroom_teacher_targets",
        *LEDGER_TABLES,
    ):
        row_count = connection.execute(
            f"SELECT COUNT(*) FROM {_quote_identifier(table_name)}"
        ).fetchone()[0]
        if row_count != 0:
            raise ValueError(
                f"target DB 不是 startup-only baseline：{table_name}={row_count}"
            )
    excluded_row = connection.execute(
        "SELECT id, deleted_at, classroom_id FROM projects WHERE id=?",
        (EXCLUDED_PROJECT_ID,),
    ).fetchone()
    if (
        excluded_row is None
        or excluded_row["deleted_at"] is not None
        or excluded_row["classroom_id"] is not None
    ):
        raise ValueError("Project 203 必須是未歸班 active project")
    excluded_student_count = connection.execute(
        "SELECT COUNT(*) FROM students WHERE project_id=?",
        (EXCLUDED_PROJECT_ID,),
    ).fetchone()[0]
    if excluded_student_count != 0:
        raise ValueError("Project 203 必須仍是零學生空殼")
    for project_id in REQUIRED_ARCHIVED_PROJECT_IDS:
        archived_row = connection.execute(
            "SELECT deleted_at, classroom_id FROM projects WHERE id=?",
            (project_id,),
        ).fetchone()
        if (
            archived_row is None
            or archived_row["deleted_at"] is None
            or archived_row["classroom_id"] is not None
        ):
            raise ValueError(f"Project {project_id} 必須已封存且尚未 replay")
    replay_rows = connection.execute(
        """SELECT id, classroom_id, class_period_work_slot_id,
                  campus_id_snapshot, campus_name_snapshot,
                  classroom_name_snapshot
           FROM projects
           WHERE deleted_at IS NULL AND id <> ?
           ORDER BY id""",
        (EXCLUDED_PROJECT_ID,),
    ).fetchall()
    if not replay_rows:
        raise ValueError("target DB 沒有可 replay 的 active legacy projects")
    for row in replay_rows:
        if any(row[column] is not None for column in PROJECT_ORGANIZATION_COLUMNS):
            raise ValueError(f"Project {row['id']} 已有部分 organization 欄位")
    replay_project_ids = [int(row["id"]) for row in replay_rows]
    current_project_ids, current_student_pairs = _current_replay_identity(
        connection
    )
    if replay_project_ids != current_project_ids:
        raise ValueError("active legacy Project identity 查詢結果不一致")
    _validate_reviewed_replay_identity(
        current_project_ids,
        current_student_pairs,
    )
    return replay_project_ids


def _validate_reference(
    connection: sqlite3.Connection,
    replay_project_ids: list[int],
) -> None:
    foreign_key_errors = _foreign_key_errors(connection)
    if foreign_key_errors:
        raise ValueError(f"reference DB foreign key errors：{foreign_key_errors[:3]}")
    if connection.execute("SELECT COUNT(*) FROM campuses").fetchone()[0] == 0:
        raise ValueError("reference DB 沒有園所資料")
    draft_rows = connection.execute(
        """SELECT term.label, term.status, plan.status
           FROM term_reclassification_plans AS plan
           JOIN academic_terms AS term ON term.id=plan.target_academic_term_id
           WHERE plan.status='draft'"""
    ).fetchall()
    if len(draft_rows) != 1 or not str(draft_rows[0]["label"]).startswith("115上"):
        raise ValueError("reference DB 缺少唯一的 115上 draft")
    for project_id in replay_project_ids:
        project_row = connection.execute(
            """SELECT classroom_id, class_period_work_slot_id,
                      campus_id_snapshot, campus_name_snapshot,
                      classroom_name_snapshot
               FROM projects WHERE id=?""",
            (project_id,),
        ).fetchone()
        if project_row is None or any(
            project_row[column] is None for column in PROJECT_ORGANIZATION_COLUMNS
        ):
            raise ValueError(f"reference Project {project_id} 尚未完整歸班")
        ledger_row = connection.execute(
            "SELECT id FROM legacy_project_classroom_migrations "
            "WHERE project_id_snapshot=?",
            (project_id,),
        ).fetchone()
        if ledger_row is None:
            raise ValueError(f"reference Project {project_id} 缺少 migration ledger")

    for table_name, expected_counts in EXPECTED_REFERENCE_COUNTS.items():
        total_count = int(
            connection.execute(
                f"SELECT COUNT(*) FROM {_quote_identifier(table_name)}"
            ).fetchone()[0]
        )
        current_count = int(
            connection.execute(
                f"SELECT COUNT(*) FROM {_quote_identifier(table_name)} "
                "WHERE ended_at IS NULL"
            ).fetchone()[0]
        )
        actual_counts = {"total": total_count, "current": current_count}
        if actual_counts != expected_counts:
            raise ValueError(
                f"reference {table_name} total/current 不符："
                f"{actual_counts} != {expected_counts}"
            )


def _legacy_teacher_link_semantics(
    connection: sqlite3.Connection,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """SELECT teacher_id, supervisor_id,
                  teacher_name_snapshot, supervisor_name_snapshot
           FROM legacy_teacher_supervisor_links
           ORDER BY teacher_id, supervisor_id"""
    ).fetchall()
    return [dict(row) for row in rows]


def _validate_preserved_legacy_teacher_links(
    target: sqlite3.Connection,
    reference: sqlite3.Connection,
) -> dict[str, Any]:
    target_semantics = _legacy_teacher_link_semantics(target)
    reference_semantics = _legacy_teacher_link_semantics(reference)
    if len(target_semantics) != EXPECTED_LEGACY_TEACHER_LINK_COUNT:
        raise ValueError(
            "target legacy teacher links 不是預期的 "
            f"{EXPECTED_LEGACY_TEACHER_LINK_COUNT} 筆"
        )
    if target_semantics != reference_semantics:
        raise ValueError("target/reference legacy teacher links 語意不一致")
    if any(
        not row["teacher_name_snapshot"] or not row["supervisor_name_snapshot"]
        for row in target_semantics
    ):
        raise ValueError("legacy teacher links 缺少姓名快照")
    # id / archived_at 會因各機 startup 插入順序與時間不同；只鎖定
    # 實際的舊師生主管關係，apply 不會寫入此表。
    return {
        "columns": list(LEGACY_TEACHER_LINK_SEMANTIC_COLUMNS),
        "rows": target_semantics,
    }


def _build_user_role_updates(
    target: sqlite3.Connection,
    reference: sqlite3.Connection,
) -> list[dict[str, Any]]:
    target_users = {
        int(row["id"]): dict(row)
        for row in target.execute(
            """SELECT id, username, display_name, role, auth_version
               FROM users ORDER BY id"""
        )
    }
    reference_users = {
        int(row["id"]): dict(row)
        for row in reference.execute(
            """SELECT id, username, display_name, role
               FROM users ORDER BY id"""
        )
    }
    if set(target_users) != set(reference_users):
        raise ValueError("target/reference User id 集合不一致")

    updates: list[dict[str, Any]] = []
    for user_id, target_user in target_users.items():
        reference_user = reference_users[user_id]
        if (
            target_user["username"] != reference_user["username"]
            or target_user["display_name"] != reference_user["display_name"]
        ):
            raise ValueError(f"User {user_id} target/reference identity 不一致")
        if target_user["role"] == reference_user["role"]:
            continue
        if target_user["role"] != "supervisor":
            raise ValueError(f"User {user_id} 有非預期 source role 差異")
        if reference_user["role"] != "teacher":
            raise ValueError(f"User {user_id} 有非預期 reference role 差異")
        source_auth_version = int(target_user["auth_version"] or 0)
        updates.append({
            "id": user_id,
            "display_name": target_user["display_name"],
            "source_role": target_user["role"],
            "source_auth_version": source_auth_version,
            "role": reference_user["role"],
            "auth_version": source_auth_version + 1,
        })

    if len(updates) != EXPECTED_USER_ROLE_UPDATE_COUNT:
        raise ValueError(
            "User role 修正計畫筆數不符："
            f"{len(updates)} != {EXPECTED_USER_ROLE_UPDATE_COUNT}"
        )
    return updates


def _validate_replay_students(
    target: sqlite3.Connection,
    reference: sqlite3.Connection,
    replay_project_ids: list[int],
) -> None:
    target_rows = _rows_for_ids(
        target,
        "students",
        "project_id",
        replay_project_ids,
        columns=("id", "project_id", "name", "order_index"),
    )
    reference_rows = _rows_for_ids(
        reference,
        "students",
        "project_id",
        replay_project_ids,
        columns=("id", "project_id", "name", "order_index", "roster_child_id"),
    )
    reference_identity = [
        {
            "id": row["id"],
            "project_id": row["project_id"],
            "name": row["name"],
            "order_index": row["order_index"],
        }
        for row in reference_rows
    ]
    if target_rows != reference_identity:
        raise ValueError("target/reference 的 replay Student identity 集合不同")
    if any(row["roster_child_id"] is None for row in reference_rows):
        raise ValueError("reference replay Student 仍有 NULL roster_child_id")
    resolution_rows = _rows_for_ids(
        reference,
        "legacy_student_identity_resolutions",
        "project_id_snapshot",
        replay_project_ids,
        columns=("student_id_snapshot", "project_id_snapshot"),
    )
    expected_pairs = sorted(
        (int(row["id"]), int(row["project_id"])) for row in target_rows
    )
    resolution_pairs = sorted(
        (
            int(row["student_id_snapshot"]),
            int(row["project_id_snapshot"]),
        )
        for row in resolution_rows
    )
    if expected_pairs != resolution_pairs:
        raise ValueError("reference resolution ledger 未完整覆蓋 replay Students")


def _build_plan(
    target: sqlite3.Connection,
    reference: sqlite3.Connection,
    *,
    target_database_path: Path,
    reference_database_path: Path,
    reference_database_sha256: str,
) -> dict[str, Any]:
    target_schema = _schema_contract(target)
    target_schema_sha256 = layout_sha256(target_schema)
    _validate_reference_schema(reference, target)
    _validate_roster_child_reference_contract(target)
    _validate_roster_child_reference_contract(reference)
    replay_project_ids = _validate_target_baseline(target)
    _validate_reference(reference, replay_project_ids)
    _validate_replay_students(target, reference, replay_project_ids)
    user_updates = _build_user_role_updates(target, reference)
    preserved_legacy_teacher_links = _validate_preserved_legacy_teacher_links(
        target,
        reference,
    )
    excluded_reference_project = reference.execute(
        "SELECT class_period_work_slot_id FROM projects WHERE id=?",
        (EXCLUDED_PROJECT_ID,),
    ).fetchone()
    if (
        excluded_reference_project is None
        or excluded_reference_project["class_period_work_slot_id"] is None
    ):
        raise ValueError("reference excluded Project 缺少工作格")
    excluded_work_slot_id = int(
        excluded_reference_project["class_period_work_slot_id"]
    )

    target_children = {
        int(row["id"]): row
        for row in _rows(target, "roster_children")
    }
    reference_children = {
        int(row["id"]): row
        for row in _rows(reference, "roster_children")
    }
    for child_id, target_child in target_children.items():
        reference_child = reference_children.get(child_id)
        if reference_child is None or reference_child["name"] != target_child["name"]:
            raise ValueError(f"RosterChild {child_id} 在 target/reference 不一致")
    replacement_tables = {}
    for table_name in REPLACEMENT_TABLES:
        target_columns = _table_columns(target, table_name)
        replacement_tables[table_name] = _table_payload(
            reference,
            table_name,
            columns=target_columns,
        )
    project_updates = _rows_for_ids(
        reference,
        "projects",
        "id",
        replay_project_ids,
        columns=("id", *PROJECT_ORGANIZATION_COLUMNS),
    )
    replay_slot_ids = {
        int(row["class_period_work_slot_id"])
        for row in project_updates
    }
    for slot_row in replacement_tables["class_period_work_slots"]["rows"]:
        if int(slot_row["id"]) not in replay_slot_ids:
            slot_row["started_at"] = None
    excluded_slot = next(
        (
            row
            for row in replacement_tables["class_period_work_slots"]["rows"]
            if int(row["id"]) == excluded_work_slot_id
        ),
        None,
    )
    if excluded_slot is None or excluded_slot["started_at"] is not None:
        raise ValueError("reference 必須含 started_at 已清空的 excluded Project 工作格")
    for project_id in REQUIRED_ARCHIVED_PROJECT_IDS:
        skipped_slot_row = reference.execute(
            "SELECT class_period_work_slot_id FROM projects WHERE id=?",
            (project_id,),
        ).fetchone()
        if skipped_slot_row is None:
            continue
        skipped_slot_id = skipped_slot_row["class_period_work_slot_id"]
        if skipped_slot_id is None or int(skipped_slot_id) in replay_slot_ids:
            continue
        planned_slot = next(
            row
            for row in replacement_tables["class_period_work_slots"]["rows"]
            if int(row["id"]) == int(skipped_slot_id)
        )
        if planned_slot["started_at"] is not None:
            raise ValueError(f"封存 Project {project_id} 的獨占 slot 未清空")

    student_updates = _rows_for_ids(
        reference,
        "students",
        "project_id",
        replay_project_ids,
        columns=("id", "project_id", "roster_child_id"),
    )
    reviewed_replay_identity = _validate_reviewed_replay_identity(
        replay_project_ids,
        sorted(
            [int(row["id"]), int(row["project_id"])]
            for row in student_updates
        ),
    )
    final_student_child_by_id = {
        int(row["id"]): row["roster_child_id"]
        for row in _rows(
            target,
            "students",
            columns=("id", "roster_child_id"),
        )
    }
    for student_update in student_updates:
        final_student_child_by_id[int(student_update["id"])] = student_update[
            "roster_child_id"
        ]
    required_child_ids = {
        int(child_id)
        for child_id in final_student_child_by_id.values()
        if child_id is not None
    }
    required_child_ids.update(
        int(row["roster_child_id"])
        for row in replacement_tables["class_roster_members"]["rows"]
    )
    missing_required_child_ids = sorted(
        required_child_ids - set(target_children)
    )
    missing_reference_ids = sorted(
        set(missing_required_child_ids) - set(reference_children)
    )
    if missing_reference_ids:
        raise ValueError(
            "final Student/Member 引用了 reference 不存在的 RosterChild："
            f"{missing_reference_ids[:3]}"
        )
    missing_child_rows = [
        reference_children[child_id]
        for child_id in missing_required_child_ids
    ]
    deleted_child_rows = [
        target_children[child_id]
        for child_id in sorted(set(target_children) - required_child_ids)
    ]
    ledger_rows = {}
    for table_name, project_column in (
        ("legacy_project_classroom_migrations", "project_id_snapshot"),
        ("legacy_student_identity_resolutions", "project_id_snapshot"),
    ):
        columns = _table_columns(target, table_name)
        ledger_rows[table_name] = {
            "columns": columns,
            "rows": _rows_for_ids(
                reference,
                table_name,
                project_column,
                replay_project_ids,
                columns=columns,
            ),
        }

    source_guard = _source_guard(target, replay_project_ids)
    plan: dict[str, Any] = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "operation": OPERATION,
        "target_database_audit_path": str(target_database_path),
        "reference_database_audit_path": str(reference_database_path),
        "target_database_sha256_before_startup_replay": _file_sha256(
            target_database_path
        ),
        "reference_database_sha256": reference_database_sha256,
        "schema_contract_sha256": target_schema_sha256,
        "source_guard": source_guard,
        "source_fingerprint": layout_sha256(source_guard),
        "replay_project_ids": replay_project_ids,
        "reviewed_replay_identity": reviewed_replay_identity,
        "excluded_project_ids": [EXCLUDED_PROJECT_ID],
        "excluded_project_work_slot_id": excluded_work_slot_id,
        "required_archived_project_ids": list(REQUIRED_ARCHIVED_PROJECT_IDS),
        "user_updates": user_updates,
        "replacement_tables": replacement_tables,
        "roster_children_to_insert": {
            "columns": _table_columns(target, "roster_children"),
            "rows": [
                {
                    column: row[column]
                    for column in _table_columns(target, "roster_children")
                }
                for row in missing_child_rows
            ],
        },
        "roster_children_to_delete": {
            "columns": _table_columns(target, "roster_children"),
            "rows": [
                {
                    column: row[column]
                    for column in _table_columns(target, "roster_children")
                }
                for row in deleted_child_rows
            ],
        },
        "preserved_legacy_teacher_supervisor_links": (
            preserved_legacy_teacher_links
        ),
        "project_updates": project_updates,
        "student_updates": student_updates,
        "ledger_rows": ledger_rows,
        "analysis": {
            "replay_project_count": len(replay_project_ids),
            "replay_student_count": len(student_updates),
            "added_roster_child_count": len(missing_child_rows),
            "deleted_roster_child_count": len(deleted_child_rows),
            "final_roster_child_count": len(required_child_ids),
            "preserved_album_name_count": len(student_updates),
            "replay_started_slot_count": len(replay_slot_ids),
            "user_role_update_count": len(user_updates),
            "legacy_teacher_link_count": len(
                preserved_legacy_teacher_links["rows"]
            ),
            "organization_counts": {
                table_name: {
                    "total": len(replacement_tables[table_name]["rows"]),
                    "current": sum(
                        row["ended_at"] is None
                        for row in replacement_tables[table_name]["rows"]
                    ),
                }
                for table_name in EXPECTED_REFERENCE_COUNTS
            },
        },
    }
    source_components = _state_component_values(target, plan)
    applied_components = _planned_applied_component_values(plan)
    plan["source_state_component_sha256"] = _state_component_hashes(
        source_components
    )
    plan["applied_state_component_sha256"] = _state_component_hashes(
        applied_components
    )
    _validate_plan_replay_identity(plan)
    return plan


def create_review_manifest(
    *,
    target_database_path: Path,
    reference_database_path: Path,
    manifest_base_path: Path = DEFAULT_MANIFEST_BASE,
    run_id: str | None = None,
) -> Path:
    target_database_path = target_database_path.resolve()
    reference_database_path = reference_database_path.resolve()
    if target_database_path == reference_database_path:
        raise ValueError("target 與 reference DB 不可相同")
    if not target_database_path.is_file() or not reference_database_path.is_file():
        raise ValueError("target/reference DB 檔案不存在")
    reference_database_sha256 = _validate_release_reference_artifact(
        reference_database_path
    )
    effective_run_id = validate_run_id(run_id or generate_run_id())
    manifest_path = run_scoped_path(
        manifest_base_path.resolve(),
        effective_run_id,
    )
    if manifest_path.exists():
        raise ValueError(f"manifest 已存在：{manifest_path}")
    with _connect(target_database_path) as target, _connect(
        reference_database_path,
        read_only=True,
    ) as reference:
        plan = _build_plan(
            target,
            reference,
            target_database_path=target_database_path,
            reference_database_path=reference_database_path,
            reference_database_sha256=reference_database_sha256,
        )
    # 規劃期間若檔案被替換或有任何 bit drift，不可寫出可供正式套用的 manifest。
    _validate_release_reference_artifact(reference_database_path)
    plan_sha256 = layout_sha256(plan)
    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "operation": OPERATION,
        "run_id": effective_run_id,
        "mode": "review-plan",
        "overall_status": "review_ready",
        "started_at": utc_now_iso(),
        "finished_at": utc_now_iso(),
        "atomicity": "single-database-transaction",
        "portable_apply": True,
        "contains_personal_data": True,
        "review_plan": plan,
        "review_plan_sha256": plan_sha256,
        "maintenance_acknowledgement_required": True,
    }
    write_manifest(manifest_path, manifest)
    return manifest_path


def _validate_manifest(manifest: dict[str, Any]) -> tuple[dict[str, Any], str]:
    if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("manifest schema version 不支援")
    if manifest.get("operation") != OPERATION:
        raise ValueError("manifest operation 不符")
    valid_statuses = {
        "review-plan": {"review_ready"},
        "reviewed-apply": {
            "applying",
            "preflight_failed",
            "reconciliation_failed",
            "complete",
        },
    }
    mode = manifest.get("mode")
    if mode not in valid_statuses or manifest.get("overall_status") not in valid_statuses[mode]:
        raise ValueError("manifest 不是可套用或可恢復的 review plan")
    plan = manifest.get("review_plan")
    if not isinstance(plan, dict):
        raise ValueError("manifest 缺少 review_plan")
    if plan.get("schema_version") != PLAN_SCHEMA_VERSION or plan.get("operation") != OPERATION:
        raise ValueError("review plan schema/operation 不符")
    if (
        plan.get("reference_database_sha256")
        != RELEASE_REFERENCE_DATABASE_SHA256
    ):
        raise ValueError("manifest reference DB SHA-256 不是本次 release artifact")
    _validate_plan_replay_identity(plan)
    plan_sha256 = layout_sha256(plan)
    if plan_sha256 != manifest.get("review_plan_sha256"):
        raise ValueError("review plan SHA-256 不符")
    return plan, plan_sha256


def _insert_rows(
    connection: sqlite3.Connection,
    table_name: str,
    table_plan: dict[str, Any],
) -> None:
    rows = table_plan["rows"]
    if not rows:
        return
    columns = table_plan["columns"]
    column_sql = ", ".join(_quote_identifier(column) for column in columns)
    placeholders = ", ".join("?" for _column in columns)
    connection.executemany(
        f"INSERT INTO {_quote_identifier(table_name)} ({column_sql}) "
        f"VALUES ({placeholders})",
        [tuple(row[column] for column in columns) for row in rows],
    )


def _apply_plan(connection: sqlite3.Connection, plan: dict[str, Any]) -> None:
    for table_name in DELETE_TABLE_ORDER:
        connection.execute(f"DELETE FROM {_quote_identifier(table_name)}")
    _insert_rows(
        connection,
        "roster_children",
        plan["roster_children_to_insert"],
    )
    for table_name in REPLACEMENT_TABLES:
        _insert_rows(
            connection,
            table_name,
            plan["replacement_tables"][table_name],
        )
    for table_name in LEDGER_TABLES:
        _insert_rows(connection, table_name, plan["ledger_rows"][table_name])
    for student_update in plan["student_updates"]:
        cursor = connection.execute(
            "UPDATE students SET roster_child_id=? WHERE id=? AND project_id=?",
            (
                student_update["roster_child_id"],
                student_update["id"],
                student_update["project_id"],
            ),
        )
        if cursor.rowcount != 1:
            raise ApplyPreflightError(
                f"Student {student_update['id']} identity update 未命中唯一 row"
            )
    project_set_sql = ", ".join(
        f"{_quote_identifier(column)}=?"
        for column in PROJECT_ORGANIZATION_COLUMNS
    )
    for project_update in plan["project_updates"]:
        cursor = connection.execute(
            f"UPDATE projects SET {project_set_sql} "
            "WHERE id=? AND deleted_at IS NULL",
            (
                *(
                    project_update[column]
                    for column in PROJECT_ORGANIZATION_COLUMNS
                ),
                project_update["id"],
            ),
        )
        if cursor.rowcount != 1:
            raise ApplyPreflightError(
                f"Project {project_update['id']} organization update 未命中唯一 active row"
            )
    for user_update in plan["user_updates"]:
        cursor = connection.execute(
            """UPDATE users
               SET role=?, auth_version=?
               WHERE id=? AND role=? AND auth_version=?""",
            (
                user_update["role"],
                user_update["auth_version"],
                user_update["id"],
                user_update["source_role"],
                user_update["source_auth_version"],
            ),
        )
        if cursor.rowcount != 1:
            raise ApplyPreflightError(
                f"User {user_update['id']} role/auth_version update 未命中唯一 row"
            )
    deleted_child_plan = plan["roster_children_to_delete"]
    deleted_child_columns = deleted_child_plan["columns"]
    exact_child_sql = " AND ".join(
        f"{_quote_identifier(column)} IS ?"
        for column in deleted_child_columns
    )
    for child_row in deleted_child_plan["rows"]:
        cursor = connection.execute(
            f"""DELETE FROM roster_children
                WHERE {exact_child_sql}
                  AND NOT EXISTS (
                      SELECT 1 FROM students
                      WHERE students.roster_child_id = roster_children.id
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM class_roster_members
                      WHERE class_roster_members.roster_child_id = roster_children.id
                  )""",
            tuple(child_row[column] for column in deleted_child_columns),
        )
        if cursor.rowcount != 1:
            raise ApplyPreflightError(
                f"RosterChild {child_row['id']} 不再是 reviewed orphan"
            )
    foreign_key_errors = _foreign_key_errors(connection)
    if foreign_key_errors:
        raise ApplyPreflightError(
            f"replay 後 foreign key errors：{foreign_key_errors[:3]}"
        )
    final_roster_child_count = int(
        connection.execute("SELECT COUNT(*) FROM roster_children").fetchone()[0]
    )
    if final_roster_child_count != plan["analysis"][
        "final_roster_child_count"
    ]:
        raise ApplyPreflightError(
            "replay 後 RosterChild 數量不符 reviewed final union"
        )
    for table_name, expected_counts in plan["analysis"][
        "organization_counts"
    ].items():
        actual_counts = {
            "total": int(
                connection.execute(
                    f"SELECT COUNT(*) FROM {_quote_identifier(table_name)}"
                ).fetchone()[0]
            ),
            "current": int(
                connection.execute(
                    f"SELECT COUNT(*) FROM {_quote_identifier(table_name)} "
                    "WHERE ended_at IS NULL"
                ).fetchone()[0]
            ),
        }
        if actual_counts != expected_counts:
            raise ApplyPreflightError(
                f"{table_name} replay total/current 不符："
                f"{actual_counts} != {expected_counts}"
            )
    applied_hashes = _state_component_hashes(
        _state_component_values(connection, plan)
    )
    if applied_hashes != plan["applied_state_component_sha256"]:
        raise ApplyPreflightError("replay 後資料 invariant 不符 reviewed plan")


def _acquire_apply_file_lock(lock_file: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        while True:
            lock_file.seek(0)
            try:
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError as error:
                if error.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise
                time.sleep(0.1)
    import fcntl

    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)


def _release_apply_file_lock(lock_file: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@contextmanager
def _lock_manifest_apply(manifest_path: Path) -> Iterator[None]:
    lock_path = manifest_path.with_suffix(f"{manifest_path.suffix}.apply.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
            os.fsync(lock_file.fileno())
        _acquire_apply_file_lock(lock_file)
        try:
            yield
        finally:
            _release_apply_file_lock(lock_file)


def _mark_manifest_failure(
    manifest_path: Path,
    manifest: dict[str, Any],
    *,
    status: str,
    error: Exception,
    database_state: str | None = None,
) -> None:
    manifest["mode"] = "reviewed-apply"
    manifest["overall_status"] = status
    manifest["finished_at"] = utc_now_iso()
    manifest["error"] = str(error)
    if database_state is not None:
        manifest["database_reconciliation"] = database_state
    write_manifest(manifest_path, manifest)


def apply_reviewed_manifest(
    *,
    target_database_path: Path,
    manifest_path: Path,
    acknowledgement: str | None,
    maintenance_acknowledged: bool,
    state_hook: Callable[[str], None] = lambda _state: None,
) -> dict[str, Any]:
    target_database_path = target_database_path.resolve()
    manifest_path = manifest_path.resolve()
    if not target_database_path.is_file() or not manifest_path.is_file():
        raise ValueError("target DB 或 manifest 不存在")
    if not maintenance_acknowledged:
        raise ValueError("套用前必須確認 maintenance window 已停止後端與 worker")
    with _lock_manifest_apply(manifest_path):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        plan, plan_sha256 = _validate_manifest(manifest)
        if acknowledgement != plan_sha256:
            raise ValueError("--acknowledge-plan-sha256 與 reviewed plan 不符")
        connection = _connect(target_database_path)
        try:
            schema_sha256 = layout_sha256(_schema_contract(connection))
            if schema_sha256 != plan["schema_contract_sha256"]:
                raise ApplyPreflightError("target DB schema/migration state 已漂移")
            connection.execute("BEGIN IMMEDIATE")
            latest_manifest = json.loads(
                manifest_path.read_text(encoding="utf-8")
            )
            latest_plan, latest_plan_sha256 = _validate_manifest(latest_manifest)
            if latest_plan_sha256 != plan_sha256:
                raise ApplyPreflightError("取得 DB lock 後 reviewed plan 已改變")
            manifest = latest_manifest
            plan = latest_plan
            database_state = _classify_database_state(connection, plan)
            if database_state in {"mixed", "diverged"}:
                raise ApplyReconciliationError(
                    f"organization replay 狀態為 {database_state}，拒絕部分覆寫",
                    database_state=database_state,
                )
            if database_state == "not_applied":
                try:
                    _validate_roster_child_reference_contract(connection)
                    current_replay_project_ids = _validate_target_baseline(
                        connection
                    )
                except ValueError as error:
                    raise ApplyPreflightError(str(error)) from error
                if current_replay_project_ids != [
                    int(value) for value in plan["replay_project_ids"]
                ]:
                    raise ApplyPreflightError(
                        "target active legacy Project 集合已漂移"
                    )
                current_source_guard = _source_guard(
                    connection,
                    [int(value) for value in plan["replay_project_ids"]],
                )
                if layout_sha256(current_source_guard) != plan["source_fingerprint"]:
                    raise ApplyPreflightError("target legacy source fingerprint 已漂移")
            manifest["mode"] = "reviewed-apply"
            manifest.setdefault("apply_started_at", utc_now_iso())
            manifest["last_apply_invocation_at"] = utc_now_iso()
            manifest["finished_at"] = None
            manifest["error"] = None
            manifest["overall_status"] = "applying"
            manifest["database_status"] = database_state
            manifest["database_reconciliation"] = database_state
            manifest["maintenance_window_acknowledged"] = True
            write_manifest(manifest_path, manifest)
            state_hook("before_database_mutation")
            if database_state == "not_applied":
                _apply_plan(connection, plan)
                state_hook("before_database_commit")
                connection.commit()
                state_hook("after_database_commit")
            else:
                connection.rollback()
            manifest["overall_status"] = "complete"
            manifest["database_status"] = "applied"
            manifest["database_reconciliation"] = "applied"
            manifest["finished_at"] = utc_now_iso()
            manifest["applied_project_count"] = plan["analysis"][
                "replay_project_count"
            ]
            manifest["applied_student_count"] = plan["analysis"][
                "replay_student_count"
            ]
            write_manifest(manifest_path, manifest)
            return manifest
        except ApplyReconciliationError as error:
            connection.rollback()
            _mark_manifest_failure(
                manifest_path,
                manifest,
                status="reconciliation_failed",
                error=error,
                database_state=error.database_state,
            )
            raise
        except ApplyPreflightError as error:
            connection.rollback()
            _mark_manifest_failure(
                manifest_path,
                manifest,
                status="preflight_failed",
                error=error,
            )
            raise
        except Exception:
            connection.rollback()
            # applying manifest 保留 crash-gap 證據；下次以 DB state reconcile。
            raise
        finally:
            connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-db", type=Path, required=True)
    parser.add_argument(
        "--reference-db",
        type=Path,
        help=(
            "dry-run 專用；只接受本次 release 凍結 artifact，SHA-256="
            f"{RELEASE_REFERENCE_DATABASE_SHA256}"
        ),
    )
    parser.add_argument(
        "--manifest-output",
        type=Path,
        default=DEFAULT_MANIFEST_BASE,
        help="dry-run manifest 檔名基底；實際檔名會附 run id",
    )
    parser.add_argument("--run-id")
    parser.add_argument("--apply-reviewed-manifest", type=Path)
    parser.add_argument("--acknowledge-plan-sha256")
    parser.add_argument(
        "--acknowledge-maintenance-window",
        action="store_true",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.apply_reviewed_manifest:
            if args.reference_db is not None:
                raise ValueError("apply 只讀 reviewed manifest，不接受 --reference-db")
            manifest = apply_reviewed_manifest(
                target_database_path=args.target_db,
                manifest_path=args.apply_reviewed_manifest,
                acknowledgement=args.acknowledge_plan_sha256,
                maintenance_acknowledged=args.acknowledge_maintenance_window,
            )
            print(
                "organization replay 完成："
                f"projects={manifest['applied_project_count']} "
                f"students={manifest['applied_student_count']}"
            )
            return 0
        if args.reference_db is None:
            raise ValueError("dry-run 必須提供 --reference-db")
        manifest_path = create_review_manifest(
            target_database_path=args.target_db,
            reference_database_path=args.reference_db,
            manifest_base_path=args.manifest_output,
            run_id=args.run_id,
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        plan = manifest["review_plan"]
        print(f"review manifest：{manifest_path}")
        print(f"plan SHA-256：{manifest['review_plan_sha256']}")
        print(
            "dry-run："
            f"projects={plan['analysis']['replay_project_count']} "
            f"students={plan['analysis']['replay_student_count']} "
            f"new_children={plan['analysis']['added_roster_child_count']}"
        )
        return 0
    except (OSError, ValueError, RuntimeError, sqlite3.DatabaseError) as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
