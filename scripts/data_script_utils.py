"""資料修復腳本共用的報告、備份與逐模板套用工具。"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from uuid import uuid4


def generate_run_id() -> str:
    """產生可排序且不重複的執行識別碼。"""
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return f"{timestamp}-{uuid4().hex[:8]}"


def validate_run_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", value):
        raise ValueError("run id 只可包含英數、點、底線與連字號")
    return value


def safe_csv_value(value: Any) -> Any:
    """避免試算表把使用者文字當成公式執行。"""
    if isinstance(value, str):
        formula_candidate = value.lstrip(" \t\r\n\v\f\ufeff")
        if (
            value.startswith(("\t", "\r", "\n", "\v", "\f"))
            or formula_candidate.startswith(("=", "+", "-", "@"))
        ):
            return "'" + value
    return value


def write_csv(report_path: Path, fieldnames: list[str], rows: Iterable[dict]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", encoding="utf-8-sig", newline="") as report_file:
        writer = csv.DictWriter(report_file, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({
                field_name: safe_csv_value(row.get(field_name, ""))
                for field_name in fieldnames
            })


def manifest_path_for_report(report_path: Path, run_id: str) -> Path:
    return report_path.with_name(f"{report_path.stem}-{run_id}.manifest.json")


def run_scoped_path(base_path: Path, run_id: str) -> Path:
    """把使用者指定的報告基底轉成不覆寫的單次執行路徑。"""
    return base_path.with_name(
        f"{base_path.stem}-{run_id}{base_path.suffix}"
    )


def write_manifest(manifest_path: Path, manifest: dict) -> None:
    """先 fsync 暫存檔再原子 replace，縮小 commit 狀態遺失窗口。"""
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = manifest_path.with_suffix(f"{manifest_path.suffix}.tmp")
    with temporary_path.open("w", encoding="utf-8", newline="\n") as manifest_file:
        json.dump(manifest, manifest_file, ensure_ascii=False, indent=2)
        manifest_file.write("\n")
        manifest_file.flush()
        os.fsync(manifest_file.fileno())
    os.replace(temporary_path, manifest_path)
    # Windows 無法可靠 fsync 目錄；兩端都先固定 replacement 本身。
    with manifest_path.open("r+b") as manifest_file:
        os.fsync(manifest_file.fileno())
    if os.name != "nt":
        directory_descriptor = os.open(manifest_path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def layout_sha256(layout: dict) -> str:
    canonical_layout = json.dumps(
        layout,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical_layout).hexdigest()


def _plan_recovery_hashes(plan: Any) -> tuple[dict[str, str], dict[str, str]]:
    changed_page_ids = {
        template_page_id
        for template_page_id, _raw_layout in plan.changed_pages
    }
    original_hashes = {
        str(template_page_id): layout_sha256(json.loads(raw_layout))
        for template_page_id, raw_layout in plan.changed_pages
    }
    planned_hashes = {
        str(page_item["id"]): layout_sha256(page_item["layout"])
        for page_item in plan.page_items
        if page_item.get("id") in changed_page_ids
    }
    return original_hashes, planned_hashes


def build_run_manifest(
    *,
    operation: str,
    run_id: str,
    database_path: Path,
    report_path: Path,
    backup_name: str,
    plans: list[Any],
    apply_requested: bool,
) -> dict:
    template_entries = []
    for plan in plans:
        original_hashes, planned_hashes = _plan_recovery_hashes(plan)
        template_entries.append({
            "template_id": plan.template_id,
            "template_name": plan.template_name,
            "expected_revision": plan.expected_revision,
            "expected_applied_revision": int(plan.expected_revision or 1) + 1,
            "template_page_ids": list(plan.expected_page_ids),
            "changed_page_ids": [
                template_page_id
                for template_page_id, _raw_layout in plan.changed_pages
            ],
            "original_changed_page_layout_sha256": original_hashes,
            "planned_changed_page_layout_sha256": planned_hashes,
            "status": "planned" if apply_requested else "dry_run",
            "error": None,
            "applied_revision": None,
            "invalidated_output_count": 0,
        })
    return {
        "schema_version": 1,
        "operation": operation,
        "run_id": run_id,
        "mode": "apply" if apply_requested else "dry-run",
        "started_at": utc_now_iso(),
        "finished_at": None,
        "overall_status": "planned" if apply_requested else "dry_run",
        "atomicity": "per-template",
        "database_path": str(database_path),
        "report_path": str(report_path),
        "backup_name": backup_name,
        "backup_status": "pending" if apply_requested and plans else "not_needed",
        "crash_reconciliation": (
            "若 status=applying，DB revision 與 planned hash 都符合時視為已套用；"
            "revision 與 original hash 都符合時視為未套用；其餘需人工檢查。"
        ),
        "templates": template_entries,
    }


def finish_manifest(
    manifest_path: Path,
    manifest: dict,
    *,
    overall_status: str,
    error: str | None = None,
) -> None:
    manifest["overall_status"] = overall_status
    manifest["finished_at"] = utc_now_iso()
    if error:
        manifest["error"] = error
    write_manifest(manifest_path, manifest)


def _manifest_template(manifest: dict, template_id: int) -> dict:
    return next(
        item
        for item in manifest["templates"]
        if item["template_id"] == template_id
    )


def classify_template_apply_state(
    template_manifest: dict,
    *,
    current_revision: int,
    current_page_ids: list[int],
    current_layouts_by_page_id: dict[int, dict],
) -> str:
    """用 revision + layout hash 判定 crash-gap 的模板實際狀態。"""
    if current_page_ids != template_manifest["template_page_ids"]:
        return "diverged"
    observed_hashes = {
        str(page_id): layout_sha256(current_layouts_by_page_id[page_id])
        for page_id in template_manifest["changed_page_ids"]
        if page_id in current_layouts_by_page_id
    }
    if len(observed_hashes) != len(template_manifest["changed_page_ids"]):
        return "diverged"
    if (
        current_revision == template_manifest["expected_applied_revision"]
        and observed_hashes
        == template_manifest["planned_changed_page_layout_sha256"]
    ):
        return "applied"
    if (
        current_revision == template_manifest["expected_revision"]
        and observed_hashes
        == template_manifest["original_changed_page_layout_sha256"]
    ):
        return "not_applied"
    return "diverged"


def preflight_template_plans(
    database_session,
    template_model,
    plans: list[Any],
) -> None:
    """在任何備份或寫入前，一次檢查所有模板 revision 與頁面集合。"""
    database_session.rollback()
    database_session.expire_all()
    errors = []
    try:
        for plan in plans:
            try:
                template = database_session.get(template_model, plan.template_id)
                if template is None:
                    errors.append(f"template_id={plan.template_id} 不存在")
                    continue
                database_session.refresh(template)
                database_session.expire(template, ["pages"])
                if template.revision != plan.expected_revision:
                    errors.append(
                        f"template_id={plan.template_id} revision 已由 "
                        f"{plan.expected_revision} 變成 {template.revision}"
                    )
                current_page_ids = [page.id for page in template.pages]
                if current_page_ids != plan.expected_page_ids:
                    errors.append(
                        f"template_id={plan.template_id} 頁面集合已變更："
                        f"預期 {plan.expected_page_ids}，目前 {current_page_ids}"
                    )
                expected_layout_hashes = getattr(
                    plan,
                    "expected_page_layout_sha256",
                    None,
                )
                if expected_layout_hashes:
                    current_layout_hashes = {
                        page.id: layout_sha256(json.loads(page.layout_json))
                        for page in template.pages
                    }
                    if current_layout_hashes != expected_layout_hashes:
                        changed_page_ids = sorted(
                            page_id
                            for page_id in set(
                                current_layout_hashes
                            ) | set(expected_layout_hashes)
                            if (
                                current_layout_hashes.get(page_id)
                                != expected_layout_hashes.get(page_id)
                            )
                        )
                        errors.append(
                            f"template_id={plan.template_id} layout 已漂移，"
                            f"page_ids={changed_page_ids}"
                        )
            except Exception as error:
                errors.append(
                    f"template_id={plan.template_id} preflight 讀取失敗：{error}"
                )
                database_session.rollback()
                database_session.expire_all()
    finally:
        database_session.rollback()
    if errors:
        raise RuntimeError("套用前全量檢查失敗：" + "；".join(errors))


def backup_original_layouts(
    database_path: Path,
    plans: list[Any],
    backup_name: str,
) -> int:
    """同一 run 的所有原始 layout 先以單一 SQLite transaction 備份。"""
    backup_count = 0
    with sqlite3.connect(database_path) as connection:
        existing_backup = connection.execute(
            """SELECT 1 FROM template_page_layout_migration_backups
               WHERE migration_name = ? LIMIT 1""",
            (backup_name,),
        ).fetchone()
        if existing_backup is not None:
            raise RuntimeError(
                f"backup_name={backup_name} 已存在；請使用新的 run id"
            )
        for plan in plans:
            for template_page_id, raw_layout in plan.changed_pages:
                connection.execute(
                    """INSERT INTO template_page_layout_migration_backups
                       (migration_name, template_page_id, layout_json)
                       VALUES (?, ?, ?)""",
                    (backup_name, template_page_id, raw_layout),
                )
                backup_count += 1
    return backup_count


def backup_name_exists(database_path: Path, backup_name: str) -> bool:
    with sqlite3.connect(database_path) as connection:
        backup_table_exists = connection.execute(
            """SELECT 1 FROM sqlite_master
               WHERE type = 'table'
                 AND name = 'template_page_layout_migration_backups'"""
        ).fetchone()
        if backup_table_exists is None:
            return False
        row = connection.execute(
            """SELECT 1 FROM template_page_layout_migration_backups
               WHERE migration_name = ? LIMIT 1""",
            (backup_name,),
        ).fetchone()
    return row is not None


@dataclass(frozen=True)
class ApplyExecutionResult:
    applied_template_ids: list[int]
    invalidated_output_count: int


class PartialApplyError(RuntimeError):
    """逐模板 transaction 中途失敗；先前成功模板不會自動回復。"""

    def __init__(
        self,
        message: str,
        *,
        manifest_path: Path,
        applied_template_ids: list[int],
        failed_template_id: int,
    ):
        super().__init__(message)
        self.manifest_path = manifest_path
        self.applied_template_ids = applied_template_ids
        self.failed_template_id = failed_template_id


def apply_template_plans(
    *,
    database_path: Path,
    database_session,
    template_model,
    plans: list[Any],
    backup_name: str,
    manifest: dict,
    manifest_path: Path,
    apply_one: Callable[[Any, Any], dict],
    require_zero_invalidations: bool = False,
) -> ApplyExecutionResult:
    """先全量 preflight／備份，再逐模板套用並持續落盤 partial 狀態。"""
    try:
        preflight_template_plans(database_session, template_model, plans)
    except Exception as error:
        manifest["backup_status"] = "not_started"
        finish_manifest(
            manifest_path,
            manifest,
            overall_status="preflight_failed",
            error=str(error),
        )
        raise

    manifest["overall_status"] = "backing_up"
    write_manifest(manifest_path, manifest)
    try:
        backup_count = backup_original_layouts(
            database_path,
            plans,
            backup_name,
        )
    except Exception as error:
        manifest["backup_status"] = "failed"
        finish_manifest(
            manifest_path,
            manifest,
            overall_status="backup_failed",
            error=str(error),
        )
        raise
    manifest["backup_status"] = "complete"
    manifest["backup_page_count"] = backup_count
    manifest["overall_status"] = "applying"
    write_manifest(manifest_path, manifest)

    applied_template_ids: list[int] = []
    invalidated_output_count = 0
    for plan_index, plan in enumerate(plans):
        template_manifest = _manifest_template(manifest, plan.template_id)
        template_manifest["status"] = "applying"
        write_manifest(manifest_path, manifest)
        try:
            template = database_session.get(template_model, plan.template_id)
            result = apply_one(plan, template)
        except Exception as error:
            database_session.rollback()
            template_manifest["status"] = "failed"
            template_manifest["error"] = str(error)
            for remaining_plan in plans[plan_index + 1:]:
                _manifest_template(
                    manifest,
                    remaining_plan.template_id,
                )["status"] = "not_applied"
            overall_status = "partial" if applied_template_ids else "failed"
            finish_manifest(
                manifest_path,
                manifest,
                overall_status=overall_status,
                error=(
                    f"template_id={plan.template_id} 套用失敗；"
                    "此模板 transaction 已 rollback，先前成功模板仍保留"
                ),
            )
            raise PartialApplyError(
                f"template_id={plan.template_id} 套用失敗：{error}",
                manifest_path=manifest_path,
                applied_template_ids=list(applied_template_ids),
                failed_template_id=plan.template_id,
            ) from error

        template_invalidated = int(
            result.get("sync", {}).get("invalidated_output_count", 0)
        )
        template_manifest["applied_revision"] = result.get("revision")
        invalidated_output_count += template_invalidated
        template_manifest["invalidated_output_count"] = template_invalidated
        if require_zero_invalidations and template_invalidated:
            template_manifest["status"] = "applied_with_error"
            template_manifest["error"] = (
                f"metadata-only 套用卻失效 {template_invalidated} 份輸出"
            )
            applied_template_ids.append(plan.template_id)
            for remaining_plan in plans[plan_index + 1:]:
                _manifest_template(
                    manifest,
                    remaining_plan.template_id,
                )["status"] = "not_applied"
            finish_manifest(
                manifest_path,
                manifest,
                overall_status="partial",
                error=template_manifest["error"],
            )
            raise PartialApplyError(
                (
                    f"template_id={plan.template_id} 已 commit，但意外失效 "
                    f"{template_invalidated} 份既有輸出"
                ),
                manifest_path=manifest_path,
                applied_template_ids=list(applied_template_ids),
                failed_template_id=plan.template_id,
            )
        template_manifest["status"] = "applied"
        applied_template_ids.append(plan.template_id)
        write_manifest(manifest_path, manifest)

    finish_manifest(manifest_path, manifest, overall_status="complete")
    return ApplyExecutionResult(
        applied_template_ids=applied_template_ids,
        invalidated_output_count=invalidated_output_count,
    )
