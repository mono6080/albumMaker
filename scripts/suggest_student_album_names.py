"""產生學生「相本稱呼」候選，人工審核後套用同一份固定計畫。

預設只讀 active 專案，輸出帶唯一 run id 的 CSV 與 manifest。腳本只處理
既有資料；只有 ``--apply-reviewed-manifest`` 能套用 dry-run 保存的候選，
套用時必須確認所有渲染已停止；同班短名碰撞、複姓候選或已完成專案還必須
以 plan hash 明確確認。
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services.student_album_name_policy import (
    KNOWN_COMPOUND_SURNAMES,
    is_han_character,
)
from scripts.data_script_utils import (
    generate_run_id,
    layout_sha256,
    manifest_path_for_report,
    run_scoped_path,
    utc_now_iso,
    validate_run_id,
    write_csv,
    write_manifest,
)


DEFAULT_DATABASE = BACKEND_DIR / "album_maker.db"
DEFAULT_REPORT = ROOT_DIR / "output" / "student-album-name-candidates.csv"
OPERATION = "suggest_student_album_names"
PLAN_SCHEMA_VERSION = 1
CLEANUP_PLAN_SCHEMA_VERSION = 1
MAINTENANCE_ACKNOWLEDGEMENT_FLAG = "--acknowledge-rendering-stopped"


class ApplyPreflightError(RuntimeError):
    """套用前資料已漂移，且尚未有任何 DB 寫入。"""


class ApplyReconciliationError(RuntimeError):
    """crash-gap 狀態不是整批未套用或整批已套用。"""

    def __init__(self, message: str, *, database_state: str):
        super().__init__(message)
        self.database_state = database_state


def _acquire_apply_file_lock(lock_file: BinaryIO) -> None:
    """取得跨程序排他鎖；程序終止或檔案關閉時由作業系統自動釋放。"""
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
    """序列化同一 manifest 的 DB 套用、cleanup 與最終狀態寫入。"""
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

@dataclass(frozen=True)
class CandidateDecision:
    candidate_album_name: str | None
    status: str
    reason: str
    review_flags: tuple[str, ...] = ()


def suggest_album_name(full_name: str) -> CandidateDecision:
    """只產生保守候選；無法可靠判斷時保留 full name 並交由人工處理。"""
    normalized_name = str(full_name or "").strip()
    if not normalized_name:
        return CandidateDecision(None, "manual_review", "完整姓名為空", ("empty_name",))
    if len(normalized_name) == 1:
        return CandidateDecision(
            None,
            "manual_review",
            "單字姓名不可再刪除字元",
            ("single_character",),
        )
    if not all(is_han_character(character) for character in normalized_name):
        return CandidateDecision(
            None,
            "manual_review",
            "非純漢字姓名不自動拆分",
            ("latin_or_mixed",),
        )
    if len(normalized_name) >= 4:
        return CandidateDecision(
            None,
            "manual_review",
            "四字以上姓名可能是複姓、雙姓或其他命名方式",
            ("compound_or_long_han",),
        )
    if normalized_name[:2] in KNOWN_COMPOUND_SURNAMES:
        return CandidateDecision(
            normalized_name[2:],
            "candidate",
            "依已知複姓產生候選，仍需人工確認",
            ("compound_surname",),
        )
    return CandidateDecision(
        normalized_name[1:],
        "candidate",
        "常見二至三字漢字姓名候選：移除第一個字",
    )


def _file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _column_names(connection: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        str(row[1])
        for row in connection.execute(f"PRAGMA table_info({table_name})")
    }


def _load_students(database_path: Path, scope: str) -> list[dict[str, Any]]:
    with sqlite3.connect(database_path) as connection:
        connection.row_factory = sqlite3.Row
        if "album_name" not in _column_names(connection, "project_students"):
            raise RuntimeError(
                "project_students.album_name 尚未建立，請先執行資料庫 migration"
            )
        project_columns = _column_names(connection, "projects")
        filters = []
        if "classroom_id" in project_columns:
            # 已歸班相本改由 Student 單一管理，本腳本只處理未歸班 legacy。
            filters.append("projects.classroom_id IS NULL")
        if scope == "active":
            filters.append("projects.deleted_at IS NULL")
        where_clause = "WHERE " + " AND ".join(filters) if filters else ""
        rows = connection.execute(
            f"""SELECT project_students.id AS student_id,
                       project_students.project_id AS project_id,
                       project_students.name AS full_name,
                       project_students.album_name AS current_album_name,
                       project_students.created_at AS student_created_at,
                       project_students.output_filename AS output_filename,
                       projects.name AS project_name,
                       projects.deleted_at AS project_deleted_at,
                       projects.completed_at AS project_completed_at
                FROM project_students
                JOIN projects ON projects.id = project_students.project_id
                {where_clause}
                ORDER BY projects.id, project_students.order_index, project_students.id"""
        ).fetchall()
    return [dict(row) for row in rows]


def build_review_rows(
    database_path: Path,
    scope: str = "active",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """建立報告、固定套用計畫與匿名統計；完全不寫入 DB。"""
    source_rows = _load_students(database_path, scope)
    report_rows: list[dict[str, Any]] = []
    for source_row in source_rows:
        current_album_name = str(source_row["current_album_name"] or "").strip()
        if current_album_name:
            decision = CandidateDecision(
                None,
                "existing",
                "已有人工作業的相本稱呼，保持不變",
            )
            effective_after = current_album_name
        else:
            decision = suggest_album_name(str(source_row["full_name"] or ""))
            effective_after = decision.candidate_album_name or source_row["full_name"]
        report_rows.append({
            **source_row,
            "candidate_album_name": decision.candidate_album_name or "",
            "effective_after": effective_after,
            "status": decision.status,
            "reason": decision.reason,
            "review_flags": list(decision.review_flags),
        })

    prospective_groups: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    for report_row in report_rows:
        prospective_name = str(report_row["effective_after"] or "").strip()
        if prospective_name:
            prospective_groups[(int(report_row["project_id"]), prospective_name)].append(report_row)
    for collision_rows in prospective_groups.values():
        if len(collision_rows) < 2:
            continue
        for report_row in collision_rows:
            if "display_collision" not in report_row["review_flags"]:
                report_row["review_flags"].append("display_collision")

    plan_students = []
    for report_row in report_rows:
        candidate_album_name = str(report_row["candidate_album_name"] or "")
        if not candidate_album_name:
            continue
        if report_row["project_completed_at"] is not None:
            report_row["review_flags"].append("completed_project")
        plan_students.append({
            "student_id": int(report_row["student_id"]),
            "project_id": int(report_row["project_id"]),
            "student_created_at": str(report_row["student_created_at"]),
            "expected_full_name": str(report_row["full_name"]),
            "expected_project_deleted_at": (
                str(report_row["project_deleted_at"])
                if report_row["project_deleted_at"] is not None
                else None
            ),
            "expected_project_completed_at": (
                str(report_row["project_completed_at"])
                if report_row["project_completed_at"] is not None
                else None
            ),
            "candidate_album_name": candidate_album_name,
            "review_flags": sorted(set(report_row["review_flags"])),
        })

    status_counts = Counter(str(row["status"]) for row in report_rows)
    report_flag_counts = Counter(
        review_flag
        for row in report_rows
        for review_flag in set(row["review_flags"])
    )
    plan_flag_counts = Counter(
        review_flag
        for student_plan in plan_students
        for review_flag in student_plan["review_flags"]
    )
    analysis = {
        "scope": scope,
        "student_count": len(report_rows),
        "planned_count": len(plan_students),
        "status_counts": dict(sorted(status_counts.items())),
        "report_review_flag_counts": dict(sorted(report_flag_counts.items())),
        "plan_review_flag_counts": dict(sorted(plan_flag_counts.items())),
        "predicted_output_invalidations": sum(
            bool(row["output_filename"])
            for row in report_rows
            if row["candidate_album_name"]
        ),
    }
    return report_rows, plan_students, analysis


def _write_report(
    report_path: Path,
    report_rows: list[dict[str, Any]],
    run_id: str,
    review_plan_hash: str,
) -> None:
    fieldnames = [
        "run_id",
        "review_plan_sha256",
        "project_id",
        "project_name",
        "student_id",
        "full_name",
        "current_album_name",
        "candidate_album_name",
        "effective_after",
        "status",
        "review_flags",
        "reason",
        "project_completed",
        "has_existing_output",
    ]
    write_csv(
        report_path,
        fieldnames,
        ({
            "run_id": run_id,
            "review_plan_sha256": review_plan_hash,
            "project_id": row["project_id"],
            "project_name": row["project_name"],
            "student_id": row["student_id"],
            "full_name": row["full_name"],
            "current_album_name": row["current_album_name"] or "",
            "candidate_album_name": row["candidate_album_name"],
            "effective_after": row["effective_after"],
            "status": row["status"],
            "review_flags": ";".join(sorted(set(row["review_flags"]))),
            "reason": row["reason"],
            "project_completed": row["project_completed_at"] is not None,
            "has_existing_output": bool(row["output_filename"]),
        } for row in report_rows),
    )


def _build_manifest(
    *,
    run_id: str,
    database_path: Path,
    report_path: Path,
    review_plan: dict[str, Any],
    review_plan_hash: str,
    report_hash: str,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "operation": OPERATION,
        "run_id": run_id,
        "mode": "review-plan",
        "started_at": utc_now_iso(),
        "finished_at": utc_now_iso(),
        "overall_status": "review_ready",
        "atomicity": "single-database-transaction",
        "database_path": str(database_path),
        "report_path": str(report_path),
        "report_sha256": report_hash,
        "review_plan": review_plan,
        "review_plan_sha256": review_plan_hash,
        "review_flags_acknowledgement_required": bool(
            review_plan["analysis"]["plan_review_flag_counts"]
        ),
    }


def _validate_reviewed_manifest(
    manifest: dict[str, Any],
    database_path: Path,
) -> tuple[dict[str, Any], str, Path]:
    if manifest.get("operation") != OPERATION:
        raise ValueError("manifest operation 不符")
    mode = manifest.get("mode")
    overall_status = manifest.get("overall_status")
    valid_statuses = {
        "review-plan": {"review_ready"},
        "reviewed-apply": {
            "applying",
            "preflight_failed",
            "reconciliation_failed",
            "cleaning_outputs",
            "complete_with_cleanup_errors",
            "complete",
        },
    }
    if mode not in valid_statuses or overall_status not in valid_statuses[mode]:
        raise ValueError("manifest 不是可套用或可恢復的 review plan")
    if Path(str(manifest.get("database_path", ""))).resolve() != database_path:
        raise ValueError("manifest 的 database_path 與 --db 不同")
    review_plan = manifest.get("review_plan")
    if not isinstance(review_plan, dict):
        raise ValueError("manifest 缺少 review_plan")
    if review_plan.get("schema_version") != PLAN_SCHEMA_VERSION:
        raise ValueError("review plan schema version 不支援")
    if review_plan.get("operation") != OPERATION:
        raise ValueError("review plan operation 不符")
    review_plan_hash = layout_sha256(review_plan)
    if review_plan_hash != manifest.get("review_plan_sha256"):
        raise ValueError("review plan SHA-256 不符")
    report_path = Path(str(manifest.get("report_path", ""))).resolve()
    if not report_path.is_file():
        raise ValueError(f"找不到原始人工審核報告 {report_path}")
    if _file_sha256(report_path) != manifest.get("report_sha256"):
        raise ValueError("人工審核報告 SHA-256 不符")
    return review_plan, review_plan_hash, report_path


def _load_current_student_rows(
    connection: sqlite3.Connection,
    student_plans: list[dict[str, Any]],
) -> tuple[dict[int, sqlite3.Row], list[str]]:
    current_rows: dict[int, sqlite3.Row] = {}
    errors: list[str] = []
    project_columns = _column_names(connection, "projects")
    classroom_id_select = (
        "projects.classroom_id AS project_classroom_id,"
        if "classroom_id" in project_columns
        else "NULL AS project_classroom_id,"
    )
    for student_plan in student_plans:
        student_id = int(student_plan["student_id"])
        current_row = connection.execute(
            f"""SELECT project_students.id AS student_id,
                      project_students.project_id AS project_id,
                      project_students.name AS full_name,
                      project_students.album_name AS album_name,
                      project_students.created_at AS student_created_at,
                      project_students.output_filename AS output_filename,
                      {classroom_id_select}
                      projects.deleted_at AS project_deleted_at,
                      projects.completed_at AS project_completed_at
               FROM project_students
               JOIN projects ON projects.id = project_students.project_id
               WHERE project_students.id = ?""",
            (student_id,),
        ).fetchone()
        if current_row is None:
            errors.append(f"student_id={student_id} 不存在")
            continue
        current_rows[student_id] = current_row
        if current_row["project_classroom_id"] is not None:
            errors.append(
                f"student_id={student_id} 已歸班，請改由園所設定管理相本稱呼"
            )
        comparisons = {
            "project_id": (
                int(current_row["project_id"]),
                int(student_plan["project_id"]),
            ),
            "full_name": (
                str(current_row["full_name"]),
                str(student_plan["expected_full_name"]),
            ),
            "created_at": (
                str(current_row["student_created_at"]),
                str(student_plan["student_created_at"]),
            ),
            "project_deleted_at": (
                str(current_row["project_deleted_at"])
                if current_row["project_deleted_at"] is not None
                else None,
                student_plan["expected_project_deleted_at"],
            ),
            "project_completed_at": (
                str(current_row["project_completed_at"])
                if current_row["project_completed_at"] is not None
                else None,
                student_plan["expected_project_completed_at"],
            ),
        }
        changed_fields = [
            field_name
            for field_name, (current_value, expected_value) in comparisons.items()
            if current_value != expected_value
        ]
        if changed_fields:
            errors.append(
                f"student_id={student_id} 已漂移：{','.join(changed_fields)}"
            )
    return current_rows, errors


def _protected_outputs_by_project(
    connection: sqlite3.Connection,
    student_plans: list[dict[str, Any]],
) -> dict[int, list[str]]:
    project_ids = sorted({int(plan["project_id"]) for plan in student_plans})
    target_student_ids = {int(plan["student_id"]) for plan in student_plans}
    protected_outputs: dict[int, set[str]] = defaultdict(set)
    for project_id in project_ids:
        rows = connection.execute(
            """SELECT id, output_filename FROM project_students
               WHERE project_id = ? AND output_filename IS NOT NULL""",
            (project_id,),
        ).fetchall()
        for row in rows:
            if int(row["id"]) in target_student_ids or not row["output_filename"]:
                continue
            protected_outputs[project_id].add(str(row["output_filename"]))
    return {
        project_id: sorted(protected_outputs[project_id])
        for project_id in project_ids
    }


def _build_cleanup_plan(
    connection: sqlite3.Connection,
    student_plans: list[dict[str, Any]],
    current_rows: dict[int, sqlite3.Row],
) -> dict[str, Any]:
    protected_outputs = _protected_outputs_by_project(connection, student_plans)
    return {
        "schema_version": CLEANUP_PLAN_SCHEMA_VERSION,
        "students": [
            {
                "project_id": int(student_plan["project_id"]),
                "student_id": int(student_plan["student_id"]),
                "previous_output_filename": current_rows[
                    int(student_plan["student_id"])
                ]["output_filename"],
                "protected_output_filenames": protected_outputs[
                    int(student_plan["project_id"])
                ],
            }
            for student_plan in student_plans
        ],
    }


def _validated_cleanup_plan(
    manifest: dict[str, Any],
    student_plans: list[dict[str, Any]],
) -> dict[str, Any] | None:
    cleanup_plan = manifest.get("cleanup_plan")
    if cleanup_plan is None:
        if manifest.get("cleanup_plan_sha256") is not None:
            raise ValueError("manifest cleanup plan 與 SHA-256 不一致")
        return None
    if not isinstance(cleanup_plan, dict):
        raise ValueError("manifest cleanup plan 格式錯誤")
    if cleanup_plan.get("schema_version") != CLEANUP_PLAN_SCHEMA_VERSION:
        raise ValueError("cleanup plan schema version 不支援")
    cleanup_plan_hash = layout_sha256(cleanup_plan)
    if cleanup_plan_hash != manifest.get("cleanup_plan_sha256"):
        raise ValueError("cleanup plan SHA-256 不符")
    cleanup_items = cleanup_plan.get("students")
    if not isinstance(cleanup_items, list):
        raise ValueError("cleanup plan 缺少 students")
    expected_pairs = [
        (int(plan["project_id"]), int(plan["student_id"]))
        for plan in student_plans
    ]
    actual_pairs = [
        (int(item.get("project_id", -1)), int(item.get("student_id", -1)))
        for item in cleanup_items
        if isinstance(item, dict)
    ]
    if len(actual_pairs) != len(cleanup_items) or actual_pairs != expected_pairs:
        raise ValueError("cleanup plan 學生集合與 review plan 不符")
    for cleanup_item in cleanup_items:
        previous_output = cleanup_item.get("previous_output_filename")
        protected_outputs = cleanup_item.get("protected_output_filenames")
        if previous_output is not None and not isinstance(previous_output, str):
            raise ValueError("cleanup plan previous_output_filename 格式錯誤")
        if (
            not isinstance(protected_outputs, list)
            or not all(isinstance(value, str) for value in protected_outputs)
        ):
            raise ValueError("cleanup plan protected_output_filenames 格式錯誤")
    return cleanup_plan


def _classify_database_apply_state(
    connection: sqlite3.Connection,
    student_plans: list[dict[str, Any]],
    cleanup_plan: dict[str, Any],
) -> tuple[str, list[str]]:
    """以完整 identity、輸出與相本稱呼判定 crash-gap 實際狀態。"""
    current_rows, errors = _load_current_student_rows(connection, student_plans)
    if errors:
        return "diverged", errors
    cleanup_items = {
        int(item["student_id"]): item
        for item in cleanup_plan["students"]
    }
    current_protected = _protected_outputs_by_project(connection, student_plans)
    states: list[str] = []
    for student_plan in student_plans:
        student_id = int(student_plan["student_id"])
        project_id = int(student_plan["project_id"])
        current_row = current_rows[student_id]
        cleanup_item = cleanup_items[student_id]
        stored_protected = cleanup_item.get("protected_output_filenames")
        if (
            not isinstance(stored_protected, list)
            or sorted(str(value) for value in stored_protected)
            != current_protected[project_id]
        ):
            errors.append(
                f"project_id={project_id} 非目標學生輸出已漂移"
            )
            continue
        album_name = str(current_row["album_name"] or "").strip()
        output_filename = current_row["output_filename"]
        if (
            not album_name
            and output_filename == cleanup_item.get("previous_output_filename")
        ):
            states.append("not_applied")
        elif (
            album_name == str(student_plan["candidate_album_name"])
            and output_filename is None
        ):
            states.append("applied")
        else:
            errors.append(
                f"student_id={student_id} 相本稱呼或輸出狀態已漂移"
            )
    if errors:
        return "diverged", errors
    if not states or all(state == "applied" for state in states):
        return "applied", []
    if all(state == "not_applied" for state in states):
        return "not_applied", []
    return "mixed", ["部分學生已套用、部分尚未套用"]


def _update_students_in_transaction(
    connection: sqlite3.Connection,
    student_plans: list[dict[str, Any]],
) -> None:
    project_ids: set[int] = set()
    for student_plan in student_plans:
        student_id = int(student_plan["student_id"])
        project_id = int(student_plan["project_id"])
        project_ids.add(project_id)
        connection.execute(
            """UPDATE project_students
               SET album_name = ?, output_filename = NULL,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (student_plan["candidate_album_name"], student_id),
        )
    for project_id in project_ids:
        connection.execute(
            "UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (project_id,),
        )


def _apply_or_reconcile_database(
    *,
    database_path: Path,
    student_plans: list[dict[str, Any]],
    expected_review_plan_hash: str,
    manifest: dict[str, Any],
    manifest_path: Path,
    state_hook: Callable[[str], None],
) -> tuple[list[dict[str, Any]], bool]:
    """鎖內固化 cleanup plan，再單一 transaction 套用或判定已套用。"""
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    try:
        if "album_name" not in _column_names(connection, "project_students"):
            raise ApplyPreflightError("project_students.album_name 尚未建立")
        connection.execute("BEGIN IMMEDIATE")

        # manifest 的檔案鎖與 SQLite 鎖是兩個資源；即使呼叫端曾讀過，仍在
        # DB write lock 內重讀，避免任何 stale dict 抹掉已固化的 cleanup plan。
        latest_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        _latest_plan, latest_plan_hash, _latest_report_path = (
            _validate_reviewed_manifest(latest_manifest, database_path)
        )
        if latest_plan_hash != expected_review_plan_hash:
            raise ValueError("取得資料庫鎖後 review plan SHA-256 已改變")
        review_flags_acknowledged = manifest.get("review_flags_acknowledged")
        manifest.clear()
        manifest.update(latest_manifest)
        manifest["review_flags_acknowledged"] = review_flags_acknowledged

        cleanup_plan = _validated_cleanup_plan(manifest, student_plans)
        if cleanup_plan is None:
            current_rows, errors = _load_current_student_rows(
                connection,
                student_plans,
            )
            for student_plan in student_plans:
                student_id = int(student_plan["student_id"])
                current_row = current_rows.get(student_id)
                if current_row is not None and str(
                    current_row["album_name"] or ""
                ).strip():
                    errors.append(f"student_id={student_id} 已設定相本稱呼")
            if errors:
                raise ApplyPreflightError(
                    "套用前全量檢查失敗：" + "；".join(errors)
                )
            cleanup_plan = _build_cleanup_plan(
                connection,
                student_plans,
                current_rows,
            )
            database_state = "not_applied"
        else:
            database_state, errors = _classify_database_apply_state(
                connection,
                student_plans,
                cleanup_plan,
            )
            if database_state in {"mixed", "diverged"}:
                raise ApplyReconciliationError(
                    "套用狀態核對失敗：" + "；".join(errors),
                    database_state=database_state,
                )
            if (
                manifest.get("overall_status")
                in {"complete", "complete_with_cleanup_errors"}
                and database_state != "applied"
            ):
                raise ApplyReconciliationError(
                    "已完成 manifest 的資料庫不再是全數已套用狀態",
                    database_state="diverged",
                )
            if (
                manifest.get("overall_status") == "complete"
                and database_state == "applied"
            ):
                connection.rollback()
                return list(cleanup_plan["students"]), False

        manifest["mode"] = "reviewed-apply"
        manifest.setdefault("apply_started_at", utc_now_iso())
        manifest["last_apply_invocation_at"] = utc_now_iso()
        manifest["finished_at"] = None
        manifest["error"] = None
        manifest["overall_status"] = "applying"
        manifest["database_status"] = database_state
        manifest["database_reconciliation"] = database_state
        manifest["cleanup_plan"] = cleanup_plan
        manifest["cleanup_plan_sha256"] = layout_sha256(cleanup_plan)
        manifest["rendering_stopped_acknowledged"] = True
        manifest["rendering_stopped_acknowledged_at"] = utc_now_iso()
        # 這次落盤先於任何 UPDATE／commit，是 crash resume 的唯一 cleanup 依據。
        write_manifest(manifest_path, manifest)

        cleanup_items = list(cleanup_plan["students"])
        if database_state == "applied":
            connection.rollback()
            return cleanup_items, False

        _update_students_in_transaction(connection, student_plans)
        state_hook("before_database_commit")
        connection.commit()
        state_hook("after_database_commit")
        return cleanup_items, True
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _cleanup_render_outputs(
    database_path: Path,
    cleanup_items: list[dict[str, Any]],
) -> list[str]:
    if not cleanup_items:
        return []
    os.environ["DATABASE_URL"] = f"sqlite:///{database_path.as_posix()}"
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    from services.storage import get_storage
    from services.student_render_service import clear_student_render_outputs

    storage = get_storage()
    errors = []
    for cleanup_item in cleanup_items:
        try:
            clear_student_render_outputs(
                storage,
                cleanup_item["project_id"],
                cleanup_item["student_id"],
                cleanup_item["previous_output_filename"],
                tuple(cleanup_item["protected_output_filenames"]),
            )
        except Exception as error:
            errors.append(
                f"student_id={cleanup_item['student_id']}：{error}"
            )
    return errors


def apply_reviewed_manifest(
    *,
    database_path: Path,
    manifest_path: Path,
    acknowledgement: str | None,
    maintenance_acknowledged: bool,
    cleanup_outputs: Callable[[Path, list[dict[str, Any]]], list[str]] = _cleanup_render_outputs,
    state_hook: Callable[[str], None] = lambda _state: None,
) -> dict[str, Any]:
    if not maintenance_acknowledged:
        raise ValueError(
            "套用期間必須停止後端與所有渲染 worker；確認已進入 maintenance window "
            f"後加上 {MAINTENANCE_ACKNOWLEDGEMENT_FLAG}"
        )
    manifest_path = manifest_path.resolve()
    with _lock_manifest_apply(manifest_path):
        return _apply_reviewed_manifest_locked(
            database_path=database_path,
            manifest_path=manifest_path,
            acknowledgement=acknowledgement,
            cleanup_outputs=cleanup_outputs,
            state_hook=state_hook,
        )


def _apply_reviewed_manifest_locked(
    *,
    database_path: Path,
    manifest_path: Path,
    acknowledgement: str | None,
    cleanup_outputs: Callable[[Path, list[dict[str, Any]]], list[str]],
    state_hook: Callable[[str], None],
) -> dict[str, Any]:
    """在同 manifest 跨程序鎖內完成 DB、cleanup 與狀態落盤。"""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    review_plan, review_plan_hash, _report_path = _validate_reviewed_manifest(
        manifest,
        database_path,
    )
    flagged_counts = review_plan["analysis"]["plan_review_flag_counts"]
    if flagged_counts and acknowledgement != review_plan_hash:
        raise ValueError(
            f"review plan 含需人工確認項目 {flagged_counts}；請以 "
            f"--acknowledge-review-flags {review_plan_hash} 明確確認同一份計畫"
        )

    manifest["review_flags_acknowledged"] = review_plan_hash if flagged_counts else None
    try:
        cleanup_items, _database_mutated = _apply_or_reconcile_database(
            database_path=database_path,
            student_plans=list(review_plan["students"]),
            expected_review_plan_hash=review_plan_hash,
            manifest=manifest,
            manifest_path=manifest_path,
            state_hook=state_hook,
        )
    except ApplyPreflightError as error:
        manifest["mode"] = "reviewed-apply"
        manifest["overall_status"] = "preflight_failed"
        manifest["finished_at"] = utc_now_iso()
        manifest["error"] = str(error)
        manifest["rendering_stopped_acknowledged"] = True
        write_manifest(manifest_path, manifest)
        raise
    except ApplyReconciliationError as error:
        manifest["mode"] = "reviewed-apply"
        manifest["overall_status"] = "reconciliation_failed"
        manifest["database_reconciliation"] = error.database_state
        manifest["finished_at"] = utc_now_iso()
        manifest["error"] = str(error)
        manifest["rendering_stopped_acknowledged"] = True
        write_manifest(manifest_path, manifest)
        raise

    manifest["database_status"] = "applied"
    manifest["database_reconciliation"] = "applied"
    manifest["applied_count"] = len(cleanup_items)
    if manifest.get("overall_status") == "complete":
        return manifest
    write_manifest(manifest_path, manifest)
    manifest["overall_status"] = "cleaning_outputs"
    manifest["cleanup_attempt_count"] = int(
        manifest.get("cleanup_attempt_count", 0)
    ) + 1
    write_manifest(manifest_path, manifest)
    try:
        cleanup_errors = cleanup_outputs(database_path, cleanup_items)
    except Exception as error:
        cleanup_errors = [f"cleanup 執行中斷：{error}"]
    manifest["cleanup_errors"] = cleanup_errors
    manifest["overall_status"] = (
        "complete_with_cleanup_errors" if cleanup_errors else "complete"
    )
    manifest["finished_at"] = utc_now_iso()
    write_manifest(manifest_path, manifest)
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--scope", choices=("active", "all"), default="active")
    parser.add_argument("--run-id", type=validate_run_id)
    parser.add_argument("--apply-reviewed-manifest", type=Path)
    parser.add_argument("--acknowledge-review-flags")
    parser.add_argument(
        MAINTENANCE_ACKNOWLEDGEMENT_FLAG,
        action="store_true",
        help="確認後端與所有渲染 worker 已停止，且套用期間維持 maintenance window",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        database_path = args.db.resolve()
        if not database_path.is_file():
            raise ValueError(f"找不到資料庫 {database_path}")
        if args.acknowledge_review_flags and not args.apply_reviewed_manifest:
            raise ValueError(
                "--acknowledge-review-flags 只可搭配 --apply-reviewed-manifest"
            )
        if args.acknowledge_rendering_stopped and not args.apply_reviewed_manifest:
            raise ValueError(
                f"{MAINTENANCE_ACKNOWLEDGEMENT_FLAG} 只可搭配 "
                "--apply-reviewed-manifest"
            )
        if args.apply_reviewed_manifest:
            manifest_path = args.apply_reviewed_manifest.resolve()
            if not manifest_path.is_file():
                raise ValueError(f"找不到 manifest {manifest_path}")
            applied_manifest = apply_reviewed_manifest(
                database_path=database_path,
                manifest_path=manifest_path,
                acknowledgement=args.acknowledge_review_flags,
                maintenance_acknowledged=args.acknowledge_rendering_stopped,
            )
            print(f"已套用相本稱呼：{applied_manifest['applied_count']} 位")
            print(f"manifest：{manifest_path}")
            if applied_manifest["cleanup_errors"]:
                print(
                    f"輸出清理失敗：{applied_manifest['cleanup_errors']}",
                    file=sys.stderr,
                )
                return 1
            return 0

        run_id = args.run_id or generate_run_id()
        report_base_path = args.report.resolve()
        report_path = run_scoped_path(report_base_path, run_id)
        manifest_path = manifest_path_for_report(report_base_path, run_id)
        if report_path.exists() or manifest_path.exists():
            raise ValueError(f"run id={run_id} 的報告或 manifest 已存在")
        report_rows, plan_students, analysis = build_review_rows(
            database_path,
            args.scope,
        )
        review_plan = {
            "schema_version": PLAN_SCHEMA_VERSION,
            "operation": OPERATION,
            "scope": args.scope,
            "students": plan_students,
            "analysis": analysis,
        }
        review_plan_hash = layout_sha256(review_plan)
        _write_report(report_path, report_rows, run_id, review_plan_hash)
        report_hash = _file_sha256(report_path)
        manifest = _build_manifest(
            run_id=run_id,
            database_path=database_path,
            report_path=report_path,
            review_plan=review_plan,
            review_plan_hash=review_plan_hash,
            report_hash=report_hash,
        )
        write_manifest(manifest_path, manifest)
        print(f"分析結果：{analysis['status_counts']}（dry-run，未寫入）")
        print(f"計畫候選：{analysis['planned_count']} 位")
        print(f"需人工確認：{analysis['plan_review_flag_counts']}")
        print(f"預計失效既有輸出：{analysis['predicted_output_invalidations']}")
        print(f"run id：{run_id}")
        print(f"報告：{report_path}")
        print(f"manifest：{manifest_path}")
        print(f"review plan SHA-256：{review_plan_hash}")
        print(
            "人工審核後套用：python scripts/suggest_student_album_names.py "
            f"--db \"{database_path}\" --apply-reviewed-manifest \"{manifest_path}\" "
            f"{MAINTENANCE_ACKNOWLEDGEMENT_FLAG}"
        )
        if analysis["plan_review_flag_counts"]:
            print(
                "並加上：--acknowledge-review-flags "
                f"{review_plan_hash}"
            )
        return 0
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, sqlite3.DatabaseError) as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
