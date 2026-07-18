"""修復 Project 203 空殼相本，建立同工作格的正常班級相本。

正式資料必須先完成 organization/reporting replay。預設只產生 CSV 與可攜式
manifest；人工核對後，使用同一份 manifest 在 maintenance window 內套用。
"""

from __future__ import annotations

import argparse
import csv
import errno
import hashlib
import json
import os
import sqlite3
import sys
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, BinaryIO, Callable, Iterator


ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts.data_script_utils import (
    generate_run_id,
    layout_sha256,
    manifest_path_for_report,
    run_scoped_path,
    safe_csv_value,
    utc_now_iso,
    validate_run_id,
    write_csv,
    write_manifest,
)
from scripts import migrate_production_organization_202607 as organization_migration
from services.student_album_name_policy import assign_automatic_album_names
from services.student_input_policy import PROJECT_STUDENT_MAX_COUNT


DEFAULT_DATABASE = BACKEND_DIR / "album_maker.db"
DEFAULT_REPORT = ROOT_DIR / "output" / "project-203-repair.csv"
OPERATION = "repair_project_203"
MANIFEST_SCHEMA_VERSION = 1
PLAN_SCHEMA_VERSION = 2
APPLY_PLAN_SCHEMA_VERSION = 1
TARGET_PROJECT_ID = 203
EXPECTED_STUDENT_COUNT = 8
ARCHIVE_DAYS = 30
MAINTENANCE_FLAG = "--acknowledge-maintenance-window"
SOURCE_PROJECT_METADATA_FIELDS = (
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
    "classroom_id",
    "class_period_work_slot_id",
    "created_by_id",
    "created_by_name",
    "campus_id_snapshot",
    "campus_name_snapshot",
    "classroom_name_snapshot",
)
REPORT_FIELDS = (
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
TARGET_PROJECT_BASE_FIELDS = (
    "id",
    "name",
    "template_id",
    "owner_id",
    "created_at",
    "label_texts_json",
    "department",
    "template_period_id",
    "completed_at",
    "template_revision",
    "created_by_id",
    "created_by_name",
)
TARGET_CONTEXT_FIELDS = (
    "id",
    "term_classroom_id",
    "term_period_id",
    "academic_term_id",
    "classroom_id",
    "campus_id_snapshot",
    "campus_name_snapshot",
    "classroom_name_snapshot",
    "classroom_department",
    "term_label",
    "term_status",
    "template_period_id",
    "period_name_snapshot",
    "period_department",
)


class RepairPreflightError(RuntimeError):
    """來源不是已核對的 replay 後狀態，禁止寫入。"""


class RepairReconciliationError(RuntimeError):
    """資料既不是 manifest 的套用前狀態，也不是精確套用後狀態。"""


def _file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _rows(connection: sqlite3.Connection, sql: str, parameters: tuple = ()) -> list[dict]:
    return [dict(row) for row in connection.execute(sql, parameters).fetchall()]


def _one(
    connection: sqlite3.Connection,
    sql: str,
    parameters: tuple = (),
) -> dict | None:
    row = connection.execute(sql, parameters).fetchone()
    return dict(row) if row is not None else None


def _required_tables(connection: sqlite3.Connection) -> None:
    expected_tables = {
        "academic_term_classroom_students",
        "academic_term_classrooms",
        "academic_term_periods",
        "academic_terms",
        "campuses",
        "class_period_work_slots",
        "class_roster_members",
        "classroom_teacher_assignments",
        "classrooms",
        "legacy_project_classroom_migrations",
        "legacy_student_identity_resolutions",
        "projects",
        "roster_children",
        "students",
        "template_periods",
        "templates",
        "users",
    }
    actual_tables = {
        str(row[0])
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    missing_tables = sorted(expected_tables - actual_tables)
    if missing_tables:
        raise RepairPreflightError(
            "organization/reporting replay 尚未完成，缺少資料表："
            + ", ".join(missing_tables)
        )


def _integrity_check(connection: sqlite3.Connection) -> None:
    result = connection.execute("PRAGMA integrity_check").fetchone()
    if result is None or result[0] != "ok":
        raise RepairPreflightError(f"SQLite integrity_check 失敗：{result}")
    foreign_key_violations = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_violations:
        raise RepairPreflightError(
            f"SQLite foreign_key_check 失敗：{foreign_key_violations[:3]}"
        )


def _load_context(
    connection: sqlite3.Connection,
    actor_user_id: int,
    work_slot_id: int,
) -> dict[str, Any]:
    _required_tables(connection)
    project = _one(
        connection,
        """SELECT id, name, template_id, owner_id, created_at, updated_at,
                  deleted_at, archive_expires_at, label_texts_json, department,
                  template_period_id, completed_at, template_revision,
                  classroom_id, class_period_work_slot_id, created_by_id,
                  created_by_name, campus_id_snapshot, campus_name_snapshot,
                  classroom_name_snapshot
           FROM projects WHERE id = ?""",
        (TARGET_PROJECT_ID,),
    )
    if project is None:
        raise RepairPreflightError(f"找不到 Project {TARGET_PROJECT_ID}")

    slot = _one(
        connection,
        """SELECT slot.id, slot.term_classroom_id, slot.term_period_id,
                  slot.started_at,
                  term_classroom.academic_term_id,
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
             ON term_classroom.id = slot.term_classroom_id
           JOIN academic_terms AS term
             ON term.id = term_classroom.academic_term_id
           JOIN academic_term_periods AS term_period
             ON term_period.id = slot.term_period_id
           JOIN classrooms AS classroom
             ON classroom.id = term_classroom.classroom_id
           JOIN campuses AS campus ON campus.id = classroom.campus_id
           WHERE slot.id = ?""",
        (work_slot_id,),
    )
    if slot is None:
        raise RepairPreflightError(
            f"organization/reporting replay 尚未建立工作格 {work_slot_id}"
        )

    template = _one(
        connection,
        """SELECT template.id, template.name, template.period_id,
                  template.revision, period.name AS period_name,
                  period.department, period.status
           FROM templates AS template
           JOIN template_periods AS period ON period.id = template.period_id
           WHERE template.id = ?""",
        (project["template_id"],),
    )
    actor = _one(
        connection,
        "SELECT id, username, display_name, role FROM users WHERE id = ?",
        (actor_user_id,),
    )
    owner = _one(
        connection,
        "SELECT id, username, display_name, role FROM users WHERE id = ?",
        (project["owner_id"],),
    )
    teacher_assignments = _rows(
        connection,
        """SELECT assignment.id, assignment.teacher_id,
                  assignment.teacher_name_snapshot, assignment.duty,
                  assignment.started_at, teacher.display_name,
                  teacher.role
           FROM classroom_teacher_assignments AS assignment
           LEFT JOIN users AS teacher ON teacher.id = assignment.teacher_id
           WHERE assignment.classroom_id = ?
             AND assignment.ended_at IS NULL
           ORDER BY assignment.id""",
        (slot["classroom_id"],),
    )
    memberships = _rows(
        connection,
        """SELECT member.id AS membership_id, member.classroom_id,
                  member.roster_child_id, member.started_at,
                  child.name AS student_name
           FROM class_roster_members AS member
           JOIN roster_children AS child ON child.id = member.roster_child_id
           WHERE member.classroom_id = ? AND member.ended_at IS NULL
           ORDER BY member.started_at, member.id""",
        (slot["classroom_id"],),
    )
    term_students = _rows(
        connection,
        """SELECT snapshot.id AS term_student_id,
                  snapshot.academic_term_id, snapshot.term_classroom_id,
                  snapshot.source_membership_id,
                  snapshot.roster_child_id_snapshot AS roster_child_id,
                  snapshot.student_name_snapshot AS student_name
           FROM academic_term_classroom_students AS snapshot
           WHERE snapshot.term_classroom_id = ?
           ORDER BY snapshot.id""",
        (slot["term_classroom_id"],),
    )
    project_students = _rows(
        connection,
        """SELECT id, project_id, name, album_name, order_index,
                  pages_data_json, output_filename, created_at, updated_at,
                  roster_child_id
           FROM students WHERE project_id = ?
           ORDER BY order_index, id""",
        (TARGET_PROJECT_ID,),
    )
    slot_projects = _rows(
        connection,
        """SELECT id, name, deleted_at
           FROM projects WHERE class_period_work_slot_id = ?
           ORDER BY id""",
        (work_slot_id,),
    )
    legacy_headers = _rows(
        connection,
        """SELECT id, project_id_snapshot, student_count, seeded_member_count
           FROM legacy_project_classroom_migrations
           WHERE project_id_snapshot = ? ORDER BY id""",
        (TARGET_PROJECT_ID,),
    )
    legacy_resolutions = _rows(
        connection,
        """SELECT id, migration_id, project_id_snapshot, student_id_snapshot
           FROM legacy_student_identity_resolutions
           WHERE project_id_snapshot = ? ORDER BY id""",
        (TARGET_PROJECT_ID,),
    )
    target_child_ids = [int(row["roster_child_id"]) for row in term_students]
    period_student_references: list[dict] = []
    if target_child_ids:
        placeholders = ",".join("?" for _value in target_child_ids)
        period_student_references = _rows(
            connection,
            f"""SELECT student.id AS student_id, student.project_id,
                       student.roster_child_id
                FROM students AS student
                JOIN projects AS candidate_project
                  ON candidate_project.id = student.project_id
                JOIN class_period_work_slots AS candidate_slot
                  ON candidate_slot.id = candidate_project.class_period_work_slot_id
                WHERE candidate_project.deleted_at IS NULL
                  AND candidate_slot.term_period_id = ?
                  AND student.roster_child_id IN ({placeholders})
                ORDER BY student.roster_child_id, student.id""",
            (slot["term_period_id"], *target_child_ids),
        )
    return {
        "project": project,
        "slot": slot,
        "template": template,
        "actor": actor,
        "owner": owner,
        "teacher_assignments": teacher_assignments,
        "memberships": memberships,
        "term_students": term_students,
        "project_students": project_students,
        "slot_projects": slot_projects,
        "legacy_headers": legacy_headers,
        "legacy_resolutions": legacy_resolutions,
        "period_student_references": period_student_references,
    }


def _stable_guard(context: dict[str, Any]) -> dict[str, Any]:
    project = context["project"]
    slot = context["slot"]
    return {
        "project": {
            key: project[key]
            for key in (
                "id",
                "name",
                "template_id",
                "owner_id",
                "created_at",
                "label_texts_json",
                "department",
                "template_period_id",
                "completed_at",
                "template_revision",
                "classroom_id",
                "class_period_work_slot_id",
                "created_by_id",
                "created_by_name",
                "campus_id_snapshot",
                "campus_name_snapshot",
                "classroom_name_snapshot",
            )
        },
        "slot_identity": {
            key: slot[key]
            for key in slot
            if key != "started_at"
        },
        "template": context["template"],
        "actor": context["actor"],
        "owner": context["owner"],
        "teacher_assignments": context["teacher_assignments"],
        "memberships": context["memberships"],
        "term_students": context["term_students"],
        "legacy_headers": context["legacy_headers"],
        "legacy_resolutions": context["legacy_resolutions"],
    }


def _validate_reference_source(context: dict[str, Any]) -> None:
    project = context["project"]
    slot = context["slot"]
    template = context["template"]
    actor = context["actor"]
    owner = context["owner"]

    if not str(project["name"]).strip():
        raise RepairPreflightError("reference Project 203 名稱不可為空")
    if project["deleted_at"] is not None or project["archive_expires_at"] is not None:
        raise RepairPreflightError("reference Project 203 已封存或已有到期時間")
    if project["completed_at"] is not None:
        raise RepairPreflightError("reference Project 203 已完成，禁止自動替換")
    if (
        project["classroom_id"] != slot["classroom_id"]
        or project["class_period_work_slot_id"] != slot["id"]
        or project["campus_id_snapshot"] != slot["campus_id_snapshot"]
        or project["campus_name_snapshot"] != slot["campus_name_snapshot"]
        or project["classroom_name_snapshot"] != slot["classroom_name_snapshot"]
    ):
        raise RepairPreflightError("reference Project 203 與工作格校班快照不一致")
    if context["project_students"]:
        raise RepairPreflightError("reference Project 203 已有 Student，禁止搬移內容")
    try:
        label_texts = json.loads(project["label_texts_json"])
    except (TypeError, json.JSONDecodeError) as error:
        raise RepairPreflightError("reference Project 203 label_texts_json 已損壞") from error
    if not isinstance(label_texts, dict):
        raise RepairPreflightError("reference Project 203 label_texts_json 必須是 object")

    if slot["started_at"] is None:
        raise RepairPreflightError("reference Project 203 工作格缺少 started_at")
    if context["slot_projects"] != [
        {"id": TARGET_PROJECT_ID, "name": project["name"], "deleted_at": None}
    ]:
        raise RepairPreflightError("reference 工作格不是只連結 Project 203")
    if slot["term_status"] not in {"imported", "active"}:
        raise RepairPreflightError("reference 工作格不屬於目前正式學期")
    if (
        slot["classroom_department"] != slot["period_department"]
        or slot["campus_id_snapshot"] != slot["current_campus_id"]
    ):
        raise RepairPreflightError("reference 工作格的校別、期別或部門不符")
    if (
        slot["current_campus_name"] != slot["campus_name_snapshot"]
        or slot["current_classroom_name"] != slot["classroom_name_snapshot"]
        or slot["current_classroom_department"] != slot["classroom_department"]
        or not slot["campus_is_active"]
        or not slot["classroom_is_active"]
    ):
        raise RepairPreflightError("reference 目標校別或班級已停用／與快照不一致")

    if template is None:
        raise RepairPreflightError("reference Project 203 的模板不存在")
    if (
        template["id"] != project["template_id"]
        or template["period_id"] != project["template_period_id"]
        or template["period_id"] != slot["template_period_id"]
        or template["period_name"] != slot["period_name_snapshot"]
        or template["department"] != slot["classroom_department"]
        or template["status"] != "active"
    ):
        raise RepairPreflightError("reference Project 203 模板與工作格期別不一致或已停用")
    if project["department"] != slot["classroom_department"]:
        raise RepairPreflightError("reference Project 203 部門不符")

    if actor is None or actor["role"] != "admin":
        raise RepairPreflightError("reference 缺少 --actor-user-id 對應的 admin")
    if owner is None or owner["role"] not in {"teacher", "supervisor"}:
        raise RepairPreflightError("Project 203 owner 不是可任教帳號")
    active_owner_assignments = [
        assignment
        for assignment in context["teacher_assignments"]
        if assignment["teacher_id"] == project["owner_id"]
    ]
    if len(active_owner_assignments) != 1:
        raise RepairPreflightError("Project 203 owner 不是目標班目前老師")
    lead_assignments = [
        assignment
        for assignment in context["teacher_assignments"]
        if assignment["duty"] == "lead"
    ]
    if len(lead_assignments) != 1:
        raise RepairPreflightError("目標班必須恰有一位目前主教")
    if any(
        assignment["role"] not in {"teacher", "supervisor"}
        for assignment in context["teacher_assignments"]
    ):
        raise RepairPreflightError("目標班含不可任教角色")

    memberships = context["memberships"]
    term_students = context["term_students"]
    if len(memberships) != EXPECTED_STUDENT_COUNT or len(term_students) != EXPECTED_STUDENT_COUNT:
        raise RepairPreflightError(
            f"目標班目前名單與正式學期快照都必須恰為 {EXPECTED_STUDENT_COUNT} 人"
        )
    if EXPECTED_STUDENT_COUNT > PROJECT_STUDENT_MAX_COUNT:
        raise RepairPreflightError("目標學生數超過單一相本上限")
    term_by_child_id = {
        int(student["roster_child_id"]): student for student in term_students
    }
    if len(term_by_child_id) != EXPECTED_STUDENT_COUNT:
        raise RepairPreflightError("正式學期快照含重複孩子身分")
    membership_child_ids = [int(member["roster_child_id"]) for member in memberships]
    if len(set(membership_child_ids)) != EXPECTED_STUDENT_COUNT:
        raise RepairPreflightError("目前名單含重複孩子身分")
    normalized_names = [str(member["student_name"]).strip() for member in memberships]
    duplicate_names = sorted(
        name for name, count in Counter(normalized_names).items() if count > 1
    )
    if duplicate_names:
        raise RepairPreflightError(f"目前名單含同名學生：{duplicate_names}")
    for membership in memberships:
        child_id = int(membership["roster_child_id"])
        term_student = term_by_child_id.get(child_id)
        if term_student is None:
            raise RepairPreflightError("目前名單與正式學期快照孩子集合不一致")
        if (
            int(term_student["source_membership_id"]) != int(membership["membership_id"])
            or str(term_student["student_name"]) != str(membership["student_name"])
            or int(term_student["academic_term_id"]) != int(slot["academic_term_id"])
        ):
            raise RepairPreflightError("目前名單與正式學期快照來源或姓名不一致")
    if context["period_student_references"]:
        raise RepairPreflightError("目標學生在本期已有有效相本快照")


def _validate_target_source(
    context: dict[str, Any],
    reference_context: dict[str, Any],
) -> None:
    project = context["project"]
    reference_project = reference_context["project"]
    if any(
        project[field] != reference_project[field]
        for field in TARGET_PROJECT_BASE_FIELDS
    ):
        raise RepairPreflightError("target Project 203 與 reference 基礎資料不一致")
    if (
        project["deleted_at"] is not None
        or project["archive_expires_at"] is not None
        or project["classroom_id"] is not None
        or project["class_period_work_slot_id"] is not None
        or project["campus_id_snapshot"] is not None
        or project["campus_name_snapshot"] is not None
        or project["classroom_name_snapshot"] is not None
    ):
        raise RepairPreflightError("target Project 203 不是 replay 後的未歸班空殼")
    if context["project_students"]:
        raise RepairPreflightError("target Project 203 已有 Student，禁止搬移內容")
    if context["legacy_headers"] or context["legacy_resolutions"]:
        raise RepairPreflightError("target Project 203 不應保留 legacy migration ledger")
    if context["slot"]["started_at"] is not None:
        raise RepairPreflightError("target 工作格已開始；不重設或覆蓋 started_at")
    if context["slot_projects"]:
        raise RepairPreflightError("target 工作格已連結其他 Project")
    target_slot_identity = {
        key: value for key, value in context["slot"].items() if key != "started_at"
    }
    reference_slot_identity = {
        key: value
        for key, value in reference_context["slot"].items()
        if key != "started_at"
    }
    if target_slot_identity != reference_slot_identity:
        raise RepairPreflightError("target 工作格與 reference 意圖不一致")
    for context_key in (
        "template",
        "actor",
        "owner",
        "teacher_assignments",
        "memberships",
        "term_students",
    ):
        if context[context_key] != reference_context[context_key]:
            raise RepairPreflightError(
                f"target {context_key} 與 reference 意圖不一致"
            )
    if context["period_student_references"]:
        raise RepairPreflightError("target 學生在本期已有有效相本快照")


def _source_state(context: dict[str, Any]) -> dict[str, Any]:
    return {
        "guard": _stable_guard(context),
        "project_mutable": {
            key: context["project"][key]
            for key in ("updated_at", "deleted_at", "archive_expires_at")
        },
        "slot_started_at": context["slot"]["started_at"],
        "slot_projects": context["slot_projects"],
        "project_students": context["project_students"],
        "period_student_references": context["period_student_references"],
    }


def build_review_plan(
    connection: sqlite3.Connection,
    reference_connection: sqlite3.Connection,
    actor_user_id: int,
    reference_database_sha256: str,
) -> dict[str, Any]:
    """建立固定修復計畫；不寫入資料庫。"""
    reference_project = _one(
        reference_connection,
        "SELECT class_period_work_slot_id FROM projects WHERE id = ?",
        (TARGET_PROJECT_ID,),
    )
    if reference_project is None:
        raise RepairPreflightError(f"reference 找不到 Project {TARGET_PROJECT_ID}")
    reference_work_slot_id = reference_project["class_period_work_slot_id"]
    if reference_work_slot_id is None:
        raise RepairPreflightError("reference Project 203 沒有工作格")
    reference_context = _load_context(
        reference_connection,
        actor_user_id,
        int(reference_work_slot_id),
    )
    _validate_reference_source(reference_context)
    source_project = {
        key: reference_context["project"][key]
        for key in SOURCE_PROJECT_METADATA_FIELDS
    }
    target_context = {
        key: reference_context["slot"][key]
        for key in TARGET_CONTEXT_FIELDS
    }

    context = _load_context(connection, actor_user_id, int(reference_work_slot_id))
    _validate_target_source(context, reference_context)
    guard = _stable_guard(context)
    guard_fingerprint = layout_sha256(guard)
    source_state = _source_state(context)
    source_fingerprint = layout_sha256(source_state)
    full_names = [
        str(member["student_name"])
        for member in reference_context["memberships"]
    ]
    album_names = assign_automatic_album_names(full_names, [])
    term_by_child_id = {
        int(student["roster_child_id"]): student
        for student in reference_context["term_students"]
    }
    students = [
        {
            "order_index": order_index,
            "membership_id": int(member["membership_id"]),
            "term_student_id": int(
                term_by_child_id[int(member["roster_child_id"])]["term_student_id"]
            ),
            "roster_child_id": int(member["roster_child_id"]),
            "name": str(member["student_name"]),
            "album_name": album_name,
        }
        for order_index, (member, album_name) in enumerate(
            zip(reference_context["memberships"], album_names, strict=True)
        )
    ]
    reference_guard = {
        "source_project": source_project,
        "target_context": target_context,
        "template": reference_context["template"],
        "owner": reference_context["owner"],
        "teacher_assignments": reference_context["teacher_assignments"],
        "memberships": reference_context["memberships"],
        "term_students": reference_context["term_students"],
        "slot_projects": reference_context["slot_projects"],
        "project_students": reference_context["project_students"],
    }
    return {
        "schema_version": PLAN_SCHEMA_VERSION,
        "operation": OPERATION,
        "reference_database_sha256": reference_database_sha256,
        "reference_guard_sha256": layout_sha256(reference_guard),
        "target_project_id": TARGET_PROJECT_ID,
        "target_work_slot_id": int(reference_work_slot_id),
        "archive_days": ARCHIVE_DAYS,
        "source_fingerprint": source_fingerprint,
        "guard_fingerprint": guard_fingerprint,
        "source_project": source_project,
        "target_context": target_context,
        "template": reference_context["template"],
        "actor": context["actor"],
        "replacement_project": {
            "name": source_project["name"],
            "template_id": int(source_project["template_id"]),
            "template_revision": int(reference_context["template"]["revision"] or 1),
            "owner_id": int(source_project["owner_id"]),
            "label_texts_json": source_project["label_texts_json"],
            "department": target_context["classroom_department"],
            "template_period_id": int(target_context["template_period_id"]),
            "classroom_id": int(target_context["classroom_id"]),
            "class_period_work_slot_id": int(reference_work_slot_id),
            "created_by_id": int(context["actor"]["id"]),
            "created_by_name": context["actor"]["display_name"],
            "campus_id_snapshot": int(target_context["campus_id_snapshot"]),
            "campus_name_snapshot": target_context["campus_name_snapshot"],
            "classroom_name_snapshot": target_context["classroom_name_snapshot"],
        },
        "students": students,
    }


def _report_rows(run_id: str, plan_hash: str, plan: dict) -> list[dict[str, Any]]:
    project = plan["replacement_project"]
    return [
        {
            "run_id": run_id,
            "review_plan_sha256": plan_hash,
            "action": "archive_project_203_and_create_replacement",
            "source_project_id": plan["target_project_id"],
            "work_slot_id": plan["target_work_slot_id"],
            "campus": project["campus_name_snapshot"],
            "classroom": project["classroom_name_snapshot"],
            "period": plan["target_context"]["period_name_snapshot"],
            "order_index": student["order_index"],
            "membership_id": student["membership_id"],
            "term_student_id": student["term_student_id"],
            "roster_child_id": student["roster_child_id"],
            "full_name": student["name"],
            "album_name": student["album_name"] or "",
        }
        for student in plan["students"]
    ]


def _write_report(report_path: Path, run_id: str, plan_hash: str, plan: dict) -> None:
    write_csv(
        report_path,
        list(REPORT_FIELDS),
        _report_rows(run_id, plan_hash, plan),
    )


def _validate_report_contract(
    report_path: Path,
    run_id: str,
    plan_hash: str,
    plan: dict[str, Any],
) -> None:
    with report_path.open("r", encoding="utf-8-sig", newline="") as report_file:
        reader = csv.DictReader(report_file)
        actual_fields = reader.fieldnames or []
        actual_rows = [dict(row) for row in reader]
    expected_rows = [
        {
            field: "" if row.get(field) is None else str(safe_csv_value(row.get(field)))
            for field in REPORT_FIELDS
        }
        for row in _report_rows(run_id, plan_hash, plan)
    ]
    if actual_fields != list(REPORT_FIELDS) or actual_rows != expected_rows:
        raise ValueError("報告內容與 review plan 不一致")


def _build_manifest(
    *,
    run_id: str,
    database_path: Path,
    report_path: Path,
    plan: dict,
    plan_hash: str,
) -> dict[str, Any]:
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "operation": OPERATION,
        "run_id": run_id,
        "mode": "dry-run",
        "created_at": utc_now_iso(),
        "finished_at": utc_now_iso(),
        "overall_status": "dry_run",
        "contains_personal_data": True,
        # 僅供人員辨識；apply 不以本機絕對路徑綁定正式環境。
        "database_hint": database_path.name,
        "report_filename": report_path.name,
        "report_sha256": _file_sha256(report_path),
        "reference_database_sha256": plan["reference_database_sha256"],
        "review_plan": plan,
        "review_plan_sha256": plan_hash,
        "source_fingerprint": plan["source_fingerprint"],
        "guard_fingerprint": plan["guard_fingerprint"],
        "maintenance_required": True,
        "database_status": "not_applied",
        "apply_plan": None,
        "apply_plan_sha256": None,
        "crash_reconciliation": (
            "精確來源狀態代表 not_applied；封存 Project 203、replacement、8 位 Student "
            "與 started_at 全部符合 apply_plan 代表 applied；其餘一律阻擋。"
        ),
    }


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _validate_plan_contract(plan: dict[str, Any]) -> None:
    if (
        plan.get("reference_database_sha256")
        != organization_migration.RELEASE_REFERENCE_DATABASE_SHA256
    ):
        raise ValueError("manifest reference DB SHA-256 不是本次 release artifact")
    if any(
        not _is_sha256(plan.get(field))
        for field in (
            "reference_guard_sha256",
            "source_fingerprint",
            "guard_fingerprint",
        )
    ):
        raise ValueError("manifest 資料指紋格式錯誤")
    if (
        plan.get("target_project_id") != TARGET_PROJECT_ID
        or plan.get("archive_days") != ARCHIVE_DAYS
    ):
        raise ValueError("manifest Project 或封存期契約不符")

    source_project = plan.get("source_project")
    target_context = plan.get("target_context")
    template = plan.get("template")
    actor = plan.get("actor")
    replacement_project = plan.get("replacement_project")
    students = plan.get("students")
    if not all(
        isinstance(value, dict)
        for value in (
            source_project,
            target_context,
            template,
            actor,
            replacement_project,
        )
    ) or not isinstance(students, list):
        raise ValueError("manifest 參考導出計畫格式錯誤")
    assert isinstance(source_project, dict)
    assert isinstance(target_context, dict)
    assert isinstance(template, dict)
    assert isinstance(actor, dict)
    assert isinstance(replacement_project, dict)
    assert isinstance(students, list)

    target_work_slot_id = plan.get("target_work_slot_id")
    if (
        source_project.get("id") != TARGET_PROJECT_ID
        or source_project.get("class_period_work_slot_id") != target_work_slot_id
        or target_context.get("id") != target_work_slot_id
        or source_project.get("classroom_id") != target_context.get("classroom_id")
        or source_project.get("campus_id_snapshot")
        != target_context.get("campus_id_snapshot")
        or source_project.get("campus_name_snapshot")
        != target_context.get("campus_name_snapshot")
        or source_project.get("classroom_name_snapshot")
        != target_context.get("classroom_name_snapshot")
        or source_project.get("template_id") != template.get("id")
        or source_project.get("template_period_id") != template.get("period_id")
        or target_context.get("template_period_id") != template.get("period_id")
        or target_context.get("period_name_snapshot") != template.get("period_name")
        or target_context.get("classroom_department") != template.get("department")
    ):
        raise ValueError("manifest reference Project／工作格／模板關係不符")
    if actor.get("role") != "admin":
        raise ValueError("manifest actor 不是 admin")
    expected_replacement = {
        "name": source_project.get("name"),
        "template_id": source_project.get("template_id"),
        "template_revision": int(template.get("revision") or 1),
        "owner_id": source_project.get("owner_id"),
        "label_texts_json": source_project.get("label_texts_json"),
        "department": target_context.get("classroom_department"),
        "template_period_id": target_context.get("template_period_id"),
        "classroom_id": target_context.get("classroom_id"),
        "class_period_work_slot_id": target_work_slot_id,
        "created_by_id": actor.get("id"),
        "created_by_name": actor.get("display_name"),
        "campus_id_snapshot": target_context.get("campus_id_snapshot"),
        "campus_name_snapshot": target_context.get("campus_name_snapshot"),
        "classroom_name_snapshot": target_context.get("classroom_name_snapshot"),
    }
    if replacement_project != expected_replacement:
        raise ValueError("manifest replacement Project 不是 reference 導出結果")
    if len(students) != EXPECTED_STUDENT_COUNT:
        raise ValueError("manifest 學生數量不符")
    if [student.get("order_index") for student in students] != list(
        range(EXPECTED_STUDENT_COUNT)
    ):
        raise ValueError("manifest 學生順序不符")
    for identity_field in ("membership_id", "term_student_id", "roster_child_id"):
        identity_values = [student.get(identity_field) for student in students]
        if (
            any(not isinstance(value, int) for value in identity_values)
            or len(set(identity_values)) != EXPECTED_STUDENT_COUNT
        ):
            raise ValueError(f"manifest 學生 {identity_field} 不符")
    if any(
        not isinstance(student.get("name"), str)
        or not str(student["name"]).strip()
        or (
            student.get("album_name") is not None
            and not isinstance(student.get("album_name"), str)
        )
        for student in students
    ):
        raise ValueError("manifest 學生姓名或相本稱呼格式錯誤")


def _validate_reviewed_manifest(
    manifest: dict[str, Any],
    manifest_path: Path,
) -> dict[str, Any]:
    if manifest.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("manifest schema version 不支援")
    if manifest.get("operation") != OPERATION:
        raise ValueError("manifest operation 不符")
    plan = manifest.get("review_plan")
    if not isinstance(plan, dict) or plan.get("schema_version") != PLAN_SCHEMA_VERSION:
        raise ValueError("manifest review plan 格式錯誤")
    _validate_plan_contract(plan)
    if manifest.get("reference_database_sha256") != plan["reference_database_sha256"]:
        raise ValueError("manifest reference DB SHA-256 不符")
    plan_hash = layout_sha256(plan)
    if plan_hash != manifest.get("review_plan_sha256"):
        raise ValueError("review plan SHA-256 不符")
    if plan.get("source_fingerprint") != manifest.get("source_fingerprint"):
        raise ValueError("manifest source fingerprint 不符")
    report_filename = manifest.get("report_filename")
    if not isinstance(report_filename, str) or Path(report_filename).name != report_filename:
        raise ValueError("manifest report filename 不安全")
    report_path = manifest_path.with_name(report_filename)
    if not report_path.is_file() or _file_sha256(report_path) != manifest.get("report_sha256"):
        raise ValueError("報告不存在或 SHA-256 不符")
    _validate_report_contract(
        report_path,
        str(manifest.get("run_id")),
        plan_hash,
        plan,
    )
    apply_plan = manifest.get("apply_plan")
    if apply_plan is None:
        if manifest.get("apply_plan_sha256") is not None:
            raise ValueError("manifest apply plan 與 SHA-256 不一致")
    else:
        if (
            not isinstance(apply_plan, dict)
            or apply_plan.get("schema_version") != APPLY_PLAN_SCHEMA_VERSION
            or layout_sha256(apply_plan) != manifest.get("apply_plan_sha256")
        ):
            raise ValueError("manifest apply plan 格式或 SHA-256 不符")
    return plan


def _acquire_file_lock(lock_file: BinaryIO) -> None:
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
    else:
        import fcntl

        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)


def _release_file_lock(lock_file: BinaryIO) -> None:
    if os.name == "nt":
        import msvcrt

        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


@contextmanager
def _lock_manifest_apply(manifest_path: Path) -> Iterator[None]:
    lock_path = manifest_path.with_suffix(f"{manifest_path.suffix}.apply.lock")
    with lock_path.open("a+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()
            os.fsync(lock_file.fileno())
        _acquire_file_lock(lock_file)
        try:
            yield
        finally:
            _release_file_lock(lock_file)


def _current_source_fingerprint(
    connection: sqlite3.Connection,
    plan: dict[str, Any],
) -> tuple[str | None, str | None]:
    try:
        context = _load_context(
            connection,
            int(plan["actor"]["id"]),
            int(plan["target_work_slot_id"]),
        )
    except RepairPreflightError as error:
        return None, str(error)
    return layout_sha256(_source_state(context)), None


def _validate_post_state(
    connection: sqlite3.Connection,
    plan: dict[str, Any],
    apply_plan: dict[str, Any],
) -> None:
    context = _load_context(
        connection,
        int(plan["actor"]["id"]),
        int(plan["target_work_slot_id"]),
    )
    if layout_sha256(_stable_guard(context)) != plan["guard_fingerprint"]:
        raise RepairReconciliationError("套用後穩定來源資料已漂移")

    project = context["project"]
    if (
        project["deleted_at"] != apply_plan["applied_at"]
        or project["archive_expires_at"] != apply_plan["archive_expires_at"]
        or project["updated_at"] != apply_plan["applied_at"]
        or project["classroom_id"] is not None
        or project["class_period_work_slot_id"] is not None
        or context["project_students"]
    ):
        raise RepairReconciliationError("Project 203 封存狀態不符 apply plan")
    if context["slot"]["started_at"] != apply_plan["applied_at"]:
        raise RepairReconciliationError("工作格 started_at 不符 apply plan")

    replacement_id = int(apply_plan["replacement_project_id"])
    replacement = _one(
        connection,
        """SELECT id, name, template_id, owner_id, created_at, updated_at,
                  deleted_at, archive_expires_at, label_texts_json, department,
                  template_period_id, completed_at, template_revision,
                  classroom_id, class_period_work_slot_id, created_by_id,
                  created_by_name, campus_id_snapshot, campus_name_snapshot,
                  classroom_name_snapshot
           FROM projects WHERE id = ?""",
        (replacement_id,),
    )
    expected_project = {
        "id": replacement_id,
        **plan["replacement_project"],
        "created_at": apply_plan["applied_at"],
        "updated_at": apply_plan["applied_at"],
        "deleted_at": None,
        "archive_expires_at": None,
        "completed_at": None,
    }
    if replacement != expected_project:
        raise RepairReconciliationError("replacement Project 不符 apply plan")

    student_rows = _rows(
        connection,
        """SELECT id, project_id, name, album_name, order_index,
                  pages_data_json, output_filename, created_at, updated_at,
                  roster_child_id
           FROM students WHERE project_id = ?
           ORDER BY order_index, id""",
        (replacement_id,),
    )
    expected_students = [
        {
            "id": int(student_id),
            "project_id": replacement_id,
            "name": student["name"],
            "album_name": student["album_name"],
            "order_index": student["order_index"],
            "pages_data_json": "[]",
            "output_filename": None,
            "created_at": apply_plan["applied_at"],
            "updated_at": apply_plan["applied_at"],
            "roster_child_id": student["roster_child_id"],
        }
        for student, student_id in zip(
            plan["students"], apply_plan["student_ids"], strict=True
        )
    ]
    if student_rows != expected_students:
        raise RepairReconciliationError("replacement Student 集合不符 apply plan")

    active_slot_projects = [
        row["id"] for row in context["slot_projects"] if row["deleted_at"] is None
    ]
    if active_slot_projects != [replacement_id]:
        raise RepairReconciliationError("工作格有效 Project 集合不符 apply plan")
    replacement_ledgers = connection.execute(
        """SELECT COUNT(*) FROM legacy_project_classroom_migrations
           WHERE project_id_snapshot = ?""",
        (replacement_id,),
    ).fetchone()[0]
    if replacement_ledgers:
        raise RepairReconciliationError("正常 replacement 不應有 legacy ledger")
    reference_rows = _rows(
        connection,
        """SELECT student.roster_child_id, student.project_id
           FROM students AS student
           JOIN projects AS candidate_project ON candidate_project.id = student.project_id
           JOIN class_period_work_slots AS candidate_slot
             ON candidate_slot.id = candidate_project.class_period_work_slot_id
           WHERE candidate_project.deleted_at IS NULL
             AND candidate_slot.term_period_id = ?
             AND student.roster_child_id IN (
                 SELECT roster_child_id_snapshot
                 FROM academic_term_classroom_students
                 WHERE term_classroom_id = ?
             )
           ORDER BY student.roster_child_id""",
        (context["slot"]["term_period_id"], context["slot"]["term_classroom_id"]),
    )
    if len(reference_rows) != len(plan["students"]) or any(
        row["project_id"] != replacement_id for row in reference_rows
    ):
        raise RepairReconciliationError("本期學生相本引用不是 replacement 唯一集合")
    _integrity_check(connection)


def _insert_replacement(
    connection: sqlite3.Connection,
    plan: dict[str, Any],
    apply_plan: dict[str, Any] | None,
) -> dict[str, Any]:
    if apply_plan is None:
        applied_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(" ")
        archive_expires_at = (
            datetime.fromisoformat(applied_at)
            + timedelta(days=int(plan["archive_days"]))
        ).isoformat(" ")
        replacement_project_id = None
        planned_student_ids: list[int] | None = None
    else:
        applied_at = str(apply_plan["applied_at"])
        archive_expires_at = str(apply_plan["archive_expires_at"])
        replacement_project_id = int(apply_plan["replacement_project_id"])
        planned_student_ids = [int(value) for value in apply_plan["student_ids"]]

    updated = connection.execute(
        """UPDATE projects
           SET deleted_at = ?, archive_expires_at = ?, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL""",
        (
            applied_at,
            archive_expires_at,
            applied_at,
            int(plan["target_project_id"]),
        ),
    )
    if updated.rowcount != 1:
        raise RepairReconciliationError("無法封存 Project 203")
    slot_updated = connection.execute(
        """UPDATE class_period_work_slots SET started_at = ?
           WHERE id = ? AND started_at IS NULL""",
        (applied_at, int(plan["target_work_slot_id"])),
    )
    if slot_updated.rowcount != 1:
        raise RepairReconciliationError(
            f"無法開始工作格 {plan['target_work_slot_id']}"
        )

    project = plan["replacement_project"]
    project_columns = (
        "name, template_id, owner_id, created_at, updated_at, deleted_at, "
        "archive_expires_at, label_texts_json, department, template_period_id, "
        "completed_at, template_revision, classroom_id, created_by_id, "
        "created_by_name, campus_id_snapshot, campus_name_snapshot, "
        "classroom_name_snapshot, class_period_work_slot_id"
    )
    project_values = (
        project["name"],
        project["template_id"],
        project["owner_id"],
        applied_at,
        applied_at,
        None,
        None,
        project["label_texts_json"],
        project["department"],
        project["template_period_id"],
        None,
        project["template_revision"],
        project["classroom_id"],
        project["created_by_id"],
        project["created_by_name"],
        project["campus_id_snapshot"],
        project["campus_name_snapshot"],
        project["classroom_name_snapshot"],
        project["class_period_work_slot_id"],
    )
    placeholders = ", ".join("?" for _value in project_values)
    if replacement_project_id is None:
        cursor = connection.execute(
            f"INSERT INTO projects ({project_columns}) VALUES ({placeholders}) RETURNING id",
            project_values,
        )
        replacement_project_id = int(cursor.fetchone()[0])
    else:
        connection.execute(
            f"INSERT INTO projects (id, {project_columns}) VALUES (?, {placeholders})",
            (replacement_project_id, *project_values),
        )

    student_ids: list[int] = []
    for index, student in enumerate(plan["students"]):
        student_values = (
            replacement_project_id,
            student["name"],
            student["album_name"],
            student["order_index"],
            "[]",
            None,
            applied_at,
            applied_at,
            student["roster_child_id"],
        )
        if planned_student_ids is None:
            cursor = connection.execute(
                """INSERT INTO students (
                       project_id, name, album_name, order_index,
                       pages_data_json, output_filename, created_at,
                       updated_at, roster_child_id
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""",
                student_values,
            )
            student_ids.append(int(cursor.fetchone()[0]))
        else:
            student_id = planned_student_ids[index]
            connection.execute(
                """INSERT INTO students (
                       id, project_id, name, album_name, order_index,
                       pages_data_json, output_filename, created_at,
                       updated_at, roster_child_id
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (student_id, *student_values),
            )
            student_ids.append(student_id)
    return {
        "schema_version": APPLY_PLAN_SCHEMA_VERSION,
        "applied_at": applied_at,
        "archive_expires_at": archive_expires_at,
        "replacement_project_id": replacement_project_id,
        "student_ids": student_ids,
    }


def apply_reviewed_manifest(
    *,
    database_path: Path,
    manifest_path: Path,
    maintenance_acknowledged: bool,
    state_hook: Callable[[str], None] = lambda _state: None,
) -> dict[str, Any]:
    if not maintenance_acknowledged:
        raise ValueError(
            f"套用前必須停止後端與所有 render worker，確認後加上 {MAINTENANCE_FLAG}"
        )
    manifest_path = manifest_path.resolve()
    database_path = database_path.resolve()
    with _lock_manifest_apply(manifest_path):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        plan = _validate_reviewed_manifest(manifest, manifest_path)
        connection = sqlite3.connect(database_path)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=5000")
            connection.execute("BEGIN IMMEDIATE")
            current_source_fingerprint, source_error = _current_source_fingerprint(
                connection,
                plan,
            )
            if current_source_fingerprint == plan["source_fingerprint"]:
                database_state = "not_applied"
            else:
                apply_plan = manifest.get("apply_plan")
                if apply_plan is None:
                    raise RepairReconciliationError(
                        "正式資料不符合 reviewed source fingerprint："
                        + (source_error or "review plan 已漂移")
                    )
                try:
                    _validate_post_state(connection, plan, apply_plan)
                except RepairReconciliationError as error:
                    raise RepairReconciliationError(
                        "正式資料既不是套用前狀態，也不是精確套用後狀態："
                        f"{source_error or 'source fingerprint changed'}；{error}"
                    ) from error
                database_state = "applied"

            if database_state == "applied":
                connection.rollback()
                manifest["mode"] = "reviewed-apply"
                manifest["overall_status"] = "complete"
                manifest["database_status"] = "applied"
                manifest["finished_at"] = utc_now_iso()
                manifest["reconciled_at"] = utc_now_iso()
                write_manifest(manifest_path, manifest)
                return manifest

            _integrity_check(connection)
            apply_plan = _insert_replacement(
                connection,
                plan,
                manifest.get("apply_plan"),
            )
            _validate_post_state(connection, plan, apply_plan)
            manifest["mode"] = "reviewed-apply"
            manifest["overall_status"] = "applying"
            manifest["database_status"] = "not_applied"
            manifest["apply_started_at"] = manifest.get("apply_started_at") or utc_now_iso()
            manifest["last_apply_invocation_at"] = utc_now_iso()
            manifest["finished_at"] = None
            manifest["apply_plan"] = apply_plan
            manifest["apply_plan_sha256"] = layout_sha256(apply_plan)
            manifest["maintenance_acknowledged"] = True
            write_manifest(manifest_path, manifest)
            state_hook("before_database_commit")
            connection.commit()
            state_hook("after_database_commit")
            manifest["overall_status"] = "complete"
            manifest["database_status"] = "applied"
            manifest["finished_at"] = utc_now_iso()
            write_manifest(manifest_path, manifest)
            return manifest
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument(
        "--reference-db",
        type=Path,
        help="dry-run 必填；只接受本次 release 已凍結 SHA-256 的單檔 SQLite reference",
    )
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--run-id", type=validate_run_id)
    parser.add_argument("--actor-user-id", type=int)
    parser.add_argument("--apply-reviewed-manifest", type=Path)
    parser.add_argument(
        MAINTENANCE_FLAG,
        action="store_true",
        help="確認後端與所有 render worker 已停止，套用期間維持 maintenance window",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        database_path = args.db.resolve()
        if not database_path.is_file():
            raise ValueError(f"找不到資料庫 {database_path}")
        if args.apply_reviewed_manifest:
            if args.reference_db is not None:
                raise ValueError("apply 只讀 reviewed manifest，不接受 --reference-db")
            manifest_path = args.apply_reviewed_manifest.resolve()
            if not manifest_path.is_file():
                raise ValueError(f"找不到 manifest {manifest_path}")
            result = apply_reviewed_manifest(
                database_path=database_path,
                manifest_path=manifest_path,
                maintenance_acknowledged=args.acknowledge_maintenance_window,
            )
            print(
                "Project 203 已封存；replacement Project "
                f"{result['apply_plan']['replacement_project_id']} 已建立，"
                f"學生 {len(result['apply_plan']['student_ids'])} 位"
            )
            print(f"manifest：{manifest_path}")
            return 0

        if args.acknowledge_maintenance_window:
            raise ValueError(f"{MAINTENANCE_FLAG} 只可搭配 --apply-reviewed-manifest")
        if args.actor_user_id is None:
            raise ValueError("dry-run 必須指定 --actor-user-id（admin）")
        if args.reference_db is None:
            raise ValueError("dry-run 必須提供 --reference-db")
        reference_database_path = args.reference_db.resolve()
        if not reference_database_path.is_file():
            raise ValueError(f"找不到 reference DB {reference_database_path}")
        if reference_database_path == database_path:
            raise ValueError("target 與 reference DB 不可相同")
        reference_database_sha256 = (
            organization_migration._validate_release_reference_artifact(
                reference_database_path
            )
        )
        run_id = args.run_id or generate_run_id()
        report_base_path = args.report.resolve()
        report_path = run_scoped_path(report_base_path, run_id)
        manifest_path = manifest_path_for_report(report_base_path, run_id)
        if report_path.exists() or manifest_path.exists():
            raise ValueError(f"run id={run_id} 的報告或 manifest 已存在")
        database_uri = f"{database_path.as_uri()}?mode=ro"
        with sqlite3.connect(database_uri, uri=True) as connection, (
            organization_migration._connect(
                reference_database_path,
                read_only=True,
            )
        ) as reference_connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA query_only=ON")
            _integrity_check(connection)
            _integrity_check(reference_connection)
            plan = build_review_plan(
                connection,
                reference_connection,
                args.actor_user_id,
                reference_database_sha256,
            )
        if (
            organization_migration._validate_release_reference_artifact(
                reference_database_path
            )
            != reference_database_sha256
        ):
            raise ValueError("reference DB 在 dry-run 期間已漂移")
        plan_hash = layout_sha256(plan)
        _write_report(report_path, run_id, plan_hash, plan)
        manifest = _build_manifest(
            run_id=run_id,
            database_path=database_path,
            report_path=report_path,
            plan=plan,
            plan_hash=plan_hash,
        )
        write_manifest(manifest_path, manifest)
        print("dry-run 完成，資料庫未寫入")
        print(f"預計封存 Project {TARGET_PROJECT_ID}")
        print(f"預計建立 replacement 與 {len(plan['students'])} 位學生")
        print(f"報告：{report_path}")
        print(f"manifest：{manifest_path}")
        print(f"review plan SHA-256：{plan_hash}")
        print(
            "核對後套用：python scripts/repair_project_203.py "
            f"--db <正式DB> --apply-reviewed-manifest \"{manifest_path}\" "
            f"{MAINTENANCE_FLAG}"
        )
        return 0
    except (
        OSError,
        RuntimeError,
        ValueError,
        json.JSONDecodeError,
        sqlite3.DatabaseError,
    ) as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
