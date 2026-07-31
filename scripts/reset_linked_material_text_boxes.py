"""以既有素材分析模組批次重設已連結文字框的幾何。

對每個 v1 group link 或 v2 ``material_text_links`` 呼叫正式的
``template_asset_service.suggest_material_text_box()``，只更新 linked text 的
``x/y/width/height/rotation``。文字、字級、樣式、貼圖、群組與圖層順序都不變。

預設產生唯一差異報告與固定幾何 review plan；人工審核後必須以
``--apply-reviewed-manifest`` 套用同一份 plan，且不會重新執行圖片分析。
寫入透過正式 template snapshot/sync service，並先備份原始 layout_json。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import sys
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import HTTPException

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.data_script_utils import (
    PartialApplyError,
    apply_template_plans,
    backup_name_exists,
    build_run_manifest,
    finish_manifest,
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
DEFAULT_REPORT = ROOT_DIR / "output" / "material-text-box-reset-report.csv"
MIGRATION_NAME = "material_text_box_reset_2026_07"
FLAT_GROUP_CONTRACT = "flat-world-v1"
GEOMETRY_FIELDS = ("x", "y", "width", "height", "rotation")
BLOCKING_STATUSES = frozenset({"missing_endpoint", "error", "unavailable"})
REVIEW_PLAN_SCHEMA_VERSION = 1
REVIEW_PLAN_OPERATION = "reset_linked_material_text_boxes"


def file_sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass
class TemplateResetPlan:
    template_id: int
    template_name: str
    expected_revision: int
    expected_page_ids: list[int]
    page_items: list[dict]
    changed_pages: list[tuple[int, str]]
    expected_page_layout_sha256: dict[int, str] = field(default_factory=dict)


def canonical_id_key(value: Any) -> str:
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)) and math.isfinite(float(value)) and float(value).is_integer():
        return str(int(value))
    return str(value)


def update_linked_text_geometry(layout: dict, text_id: Any, geometry: dict) -> dict:
    next_layout = deepcopy(layout)
    target_key = canonical_id_key(text_id)
    found = False
    next_text_labels = []
    for text_label in next_layout.get("text_labels") or []:
        if canonical_id_key(text_label.get("id")) != target_key:
            next_text_labels.append(text_label)
            continue
        found = True
        next_text_labels.append({
            **text_label,
            **{field_name: geometry[field_name] for field_name in GEOMETRY_FIELDS},
        })
    if not found:
        raise ValueError(f"找不到 linked text_id={text_id}")
    next_layout["text_labels"] = next_text_labels
    return next_layout


def geometry_for_report(element: dict) -> dict[str, float]:
    return {
        field_name: float(element.get(field_name, 0) or 0)
        for field_name in GEOMETRY_FIELDS
    }


def geometry_changed(before: dict, after: dict) -> bool:
    return any(
        abs(float(before.get(field_name, 0) or 0) - float(after[field_name])) > 0.0005
        for field_name in GEOMETRY_FIELDS
    )


def geometry_delta(before: dict, after: dict, sticker: dict) -> dict:
    before_width = max(0.001, float(before.get("width", 0) or 0))
    before_height = max(0.001, float(before.get("height", 0) or 0))
    before_center = (
        float(before.get("x", 0) or 0) + before_width / 2,
        float(before.get("y", 0) or 0) + before_height / 2,
    )
    after_center = (
        float(after["x"]) + float(after["width"]) / 2,
        float(after["y"]) + float(after["height"]) / 2,
    )
    center_shift = math.dist(before_center, after_center)
    sticker_diagonal = math.hypot(
        float(sticker.get("width", 0) or 0),
        float(sticker.get("height", 0) or 0),
    )
    area_ratio = (
        float(after["width"]) * float(after["height"])
        / (before_width * before_height)
    )
    return {
        "width_ratio": float(after["width"]) / before_width,
        "height_ratio": float(after["height"]) / before_height,
        "area_ratio": area_ratio,
        "center_shift": center_shift,
        "center_shift_ratio": center_shift / max(sticker_diagonal, 0.001),
    }


def review_flag(confidence: float, delta: dict) -> str:
    reasons = []
    if confidence < 0.65:
        reasons.append("low_confidence")
    if delta["area_ratio"] < 0.5:
        reasons.append("area_shrink_gt_50pct")
    if delta["area_ratio"] > 2:
        reasons.append("area_expand_gt_2x")
    if delta["center_shift_ratio"] > 0.25:
        reasons.append("large_center_shift")
    return ",".join(reasons)


def get_material_text_links(layout: dict) -> list[dict]:
    top_level_links = layout.get("material_text_links")
    if isinstance(top_level_links, list):
        return [link for link in top_level_links if isinstance(link, dict)]
    if layout.get("group_contract") == FLAT_GROUP_CONTRACT:
        return [
            link
            for group in (layout.get("groups") or [])
            if isinstance(group, dict)
            for link in (group.get("links") or [])
            if isinstance(link, dict)
        ]
    return []


def write_report(
    report_path: Path,
    rows: list[dict],
    run_id: str,
    review_plan_hash: str = "",
) -> None:
    fieldnames = [
        "run_id",
        "review_plan_sha256",
        "template_id",
        "template_name",
        "template_page_id",
        "page_number",
        "text_id",
        "material_id",
        "status",
        "reason",
        "confidence",
        "review_flag",
        "old_x",
        "old_y",
        "old_width",
        "old_height",
        "old_rotation",
        "new_x",
        "new_y",
        "new_width",
        "new_height",
        "new_rotation",
        "width_ratio",
        "height_ratio",
        "area_ratio",
        "center_shift",
        "center_shift_ratio",
    ]
    write_csv(
        report_path,
        fieldnames,
        (
            {
                **row,
                "run_id": run_id,
                "review_plan_sha256": review_plan_hash,
            }
            for row in rows
        ),
    )


def blocking_status_counts(rows: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        status = row.get("status")
        if status in BLOCKING_STATUSES:
            counts[status] = counts.get(status, 0) + 1
    return counts


def review_flag_counts(rows: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for row in rows:
        for flag in str(row.get("review_flag") or "").split(","):
            if flag:
                counts[flag] = counts.get(flag, 0) + 1
    return counts


def _expected_layout_hashes_for_plan(
    plan: TemplateResetPlan,
) -> dict[int, str]:
    original_layouts_by_page_id = {
        template_page_id: json.loads(raw_layout)
        for template_page_id, raw_layout in plan.changed_pages
    }
    planned_layouts_by_page_id = {
        int(page_item["id"]): page_item["layout"]
        for page_item in plan.page_items
    }
    if list(planned_layouts_by_page_id) != plan.expected_page_ids:
        raise ValueError(
            f"template_id={plan.template_id} 計畫頁面順序不完整"
        )
    return {
        page_id: layout_sha256(
            original_layouts_by_page_id.get(
                page_id,
                planned_layouts_by_page_id[page_id],
            )
        )
        for page_id in plan.expected_page_ids
    }


def _geometry_updates_for_changed_page(
    original_layout: dict,
    planned_layout: dict,
) -> list[dict]:
    original_texts_by_id = {
        canonical_id_key(text_label.get("id")): text_label
        for text_label in original_layout.get("text_labels") or []
        if isinstance(text_label, dict)
    }
    geometry_updates = []
    for planned_text in planned_layout.get("text_labels") or []:
        if not isinstance(planned_text, dict):
            continue
        original_text = original_texts_by_id.get(
            canonical_id_key(planned_text.get("id"))
        )
        if original_text is None:
            continue
        if all(
            original_text.get(field_name) == planned_text.get(field_name)
            for field_name in GEOMETRY_FIELDS
        ):
            continue
        geometry_updates.append({
            "text_id": planned_text.get("id"),
            "geometry": {
                field_name: planned_text[field_name]
                for field_name in GEOMETRY_FIELDS
            },
        })

    reconstructed_layout = original_layout
    for update in geometry_updates:
        reconstructed_layout = update_linked_text_geometry(
            reconstructed_layout,
            update["text_id"],
            update["geometry"],
        )
    if layout_sha256(reconstructed_layout) != layout_sha256(planned_layout):
        raise ValueError("review plan 無法只靠文字框幾何重建")
    return geometry_updates


def build_review_plan(
    plans: list[TemplateResetPlan],
    *,
    blocking_counts: dict[str, int],
    flagged_counts: dict[str, int],
) -> dict:
    """只保存可重建同一幾何的 patch，不複製整份 layout 文字內容。"""
    template_entries = []
    for plan in plans:
        planned_layouts_by_page_id = {
            int(page_item["id"]): page_item["layout"]
            for page_item in plan.page_items
        }
        expected_layout_hashes = _expected_layout_hashes_for_plan(plan)
        changed_page_entries = []
        for template_page_id, raw_layout in plan.changed_pages:
            original_layout = json.loads(raw_layout)
            planned_layout = planned_layouts_by_page_id[template_page_id]
            changed_page_entries.append({
                "template_page_id": template_page_id,
                "original_layout_sha256": layout_sha256(original_layout),
                "planned_layout_sha256": layout_sha256(planned_layout),
                "text_geometry_updates": _geometry_updates_for_changed_page(
                    original_layout,
                    planned_layout,
                ),
            })
        template_entries.append({
            "template_id": plan.template_id,
            "expected_revision": plan.expected_revision,
            "expected_page_ids": list(plan.expected_page_ids),
            "expected_page_layout_sha256": {
                str(page_id): expected_layout_hashes[page_id]
                for page_id in plan.expected_page_ids
            },
            "changed_pages": changed_page_entries,
        })
    return {
        "schema_version": REVIEW_PLAN_SCHEMA_VERSION,
        "operation": REVIEW_PLAN_OPERATION,
        "analysis": {
            "blocking_status_counts": blocking_counts,
            "review_flag_counts": flagged_counts,
        },
        "templates": template_entries,
    }


def validate_review_manifest(manifest: dict) -> tuple[dict, str]:
    if manifest.get("operation") != REVIEW_PLAN_OPERATION:
        raise ValueError("manifest 不是文字框重設計畫")
    if manifest.get("mode") != "review-plan":
        raise ValueError("manifest 不是可人工審核的 dry-run 計畫")
    if manifest.get("overall_status") != "review_ready":
        raise ValueError(
            "manifest 尚未處於 review_ready，或已經嘗試套用"
        )
    review_plan = manifest.get("review_plan")
    if not isinstance(review_plan, dict):
        raise ValueError("manifest 缺少 review_plan")
    if review_plan.get("schema_version") != REVIEW_PLAN_SCHEMA_VERSION:
        raise ValueError("review plan schema_version 不支援")
    if review_plan.get("operation") != REVIEW_PLAN_OPERATION:
        raise ValueError("review plan operation 不符")
    expected_hash = manifest.get("review_plan_sha256")
    observed_hash = layout_sha256(review_plan)
    if not isinstance(expected_hash, str) or observed_hash != expected_hash:
        raise ValueError("review plan SHA-256 不符，檔案可能已被修改")
    analysis = review_plan.get("analysis")
    if not isinstance(analysis, dict):
        raise ValueError("review plan 缺少分析摘要")
    blocking_counts = analysis.get("blocking_status_counts")
    if not isinstance(blocking_counts, dict) or blocking_counts:
        raise ValueError("review plan 含不可套用的分析項目")
    if not isinstance(analysis.get("review_flag_counts"), dict):
        raise ValueError("review plan 缺少 review_flag 摘要")
    if not isinstance(review_plan.get("templates"), list):
        raise ValueError("review plan templates 格式錯誤")
    return review_plan, expected_hash


def plans_from_review_manifest(
    database_session,
    template_model,
    validate_layout,
    review_plan: dict,
) -> list[TemplateResetPlan]:
    """從已審 plan 重建 page_items；此路徑不執行任何圖片分析。"""
    plans = []
    seen_template_ids = set()
    for template_entry in review_plan["templates"]:
        template_id = template_entry.get("template_id")
        if (
            isinstance(template_id, bool)
            or not isinstance(template_id, int)
            or template_id in seen_template_ids
        ):
            raise ValueError("review plan template_id 不合法或重複")
        seen_template_ids.add(template_id)
        template = database_session.get(template_model, template_id)
        if template is None:
            raise RuntimeError(f"template_id={template_id} 不存在")
        database_session.refresh(template)
        database_session.expire(template, ["pages"])
        expected_revision = template_entry.get("expected_revision")
        if template.revision != expected_revision:
            raise RuntimeError(
                f"template_id={template_id} revision 已由 "
                f"{expected_revision} 變成 {template.revision}"
            )
        expected_page_ids = template_entry.get("expected_page_ids")
        current_page_ids = [page.id for page in template.pages]
        if current_page_ids != expected_page_ids:
            raise RuntimeError(
                f"template_id={template_id} 頁面集合已變更："
                f"預期 {expected_page_ids}，目前 {current_page_ids}"
            )
        raw_expected_hashes = template_entry.get(
            "expected_page_layout_sha256"
        )
        if not isinstance(raw_expected_hashes, dict):
            raise ValueError("review plan 缺少全頁 layout hash")
        expected_layout_hashes = {
            int(page_id): page_hash
            for page_id, page_hash in raw_expected_hashes.items()
        }
        current_layouts_by_page_id = {
            page.id: json.loads(page.layout_json)
            for page in template.pages
        }
        current_layout_hashes = {
            page_id: layout_sha256(layout)
            for page_id, layout in current_layouts_by_page_id.items()
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
            raise RuntimeError(
                f"template_id={template_id} layout 已漂移，"
                f"page_ids={changed_page_ids}"
            )

        changed_entries = template_entry.get("changed_pages")
        if not isinstance(changed_entries, list):
            raise ValueError("review plan changed_pages 格式錯誤")
        changed_by_page_id = {}
        for changed_entry in changed_entries:
            page_id = changed_entry.get("template_page_id")
            if page_id in changed_by_page_id or page_id not in current_layouts_by_page_id:
                raise ValueError("review plan changed page 不合法或重複")
            changed_by_page_id[page_id] = changed_entry

        page_items = []
        changed_pages = []
        for page in template.pages:
            original_layout = current_layouts_by_page_id[page.id]
            planned_layout = original_layout
            changed_entry = changed_by_page_id.get(page.id)
            if changed_entry is not None:
                if (
                    layout_sha256(original_layout)
                    != changed_entry.get("original_layout_sha256")
                ):
                    raise RuntimeError(
                        f"template_id={template_id} page_id={page.id} "
                        "原始 layout hash 不符"
                    )
                geometry_updates = changed_entry.get(
                    "text_geometry_updates"
                )
                if not isinstance(geometry_updates, list):
                    raise ValueError("review plan geometry updates 格式錯誤")
                for update in geometry_updates:
                    geometry = update.get("geometry")
                    if (
                        not isinstance(geometry, dict)
                        or set(geometry) != set(GEOMETRY_FIELDS)
                    ):
                        raise ValueError("review plan geometry 欄位不完整")
                    planned_layout = update_linked_text_geometry(
                        planned_layout,
                        update.get("text_id"),
                        geometry,
                    )
                if (
                    layout_sha256(planned_layout)
                    != changed_entry.get("planned_layout_sha256")
                ):
                    raise ValueError(
                        f"template_id={template_id} page_id={page.id} "
                        "重建後 planned layout hash 不符"
                    )
                if validate_layout(planned_layout):
                    raise ValueError(
                        f"template_id={template_id} page_id={page.id} "
                        "已審 layout 驗證失敗"
                    )
                changed_pages.append((page.id, page.layout_json))
            page_items.append({
                "id": page.id,
                "client_id": None,
                "layout": planned_layout,
            })
        if set(changed_by_page_id) != {
            page_id for page_id, _raw_layout in changed_pages
        }:
            raise ValueError("review plan changed_pages 未完整重建")
        plans.append(TemplateResetPlan(
            template_id=template.id,
            template_name=template.name,
            expected_revision=expected_revision,
            expected_page_ids=expected_page_ids,
            page_items=page_items,
            changed_pages=changed_pages,
            expected_page_layout_sha256=expected_layout_hashes,
        ))
    return plans


def configure_backend(database_path: Path):
    os.environ["DATABASE_URL"] = f"sqlite:///{database_path.resolve().as_posix()}"
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    from database import Project, SessionLocal, ProjectStudent, Template
    from services.layout_group_validation import validate_layout_groups
    from services.material_text_box import project_normalized_box_to_sticker
    from services.template_asset_service import suggest_material_text_box
    from services.template_page_snapshot_service import replace_template_pages_snapshot

    return (
        Project,
        SessionLocal,
        ProjectStudent,
        Template,
        validate_layout_groups,
        project_normalized_box_to_sticker,
        suggest_material_text_box,
        replace_template_pages_snapshot,
    )


def build_reset_plans(
    database_session,
    template_model,
    validate_layout,
    project_normalized_box_to_sticker,
    suggest_material_text_box,
) -> tuple[list[TemplateResetPlan], list[dict]]:
    plans = []
    report_rows = []
    templates = database_session.query(template_model).order_by(template_model.id).all()
    for template in templates:
        expected_page_ids = [page.id for page in template.pages]
        page_items = []
        changed_pages = []
        for page in template.pages:
            layout = json.loads(page.layout_json)
            validation_errors = validate_layout(layout)
            if validation_errors:
                raise RuntimeError(
                    f"template_id={template.id} page={page.page_number + 1} "
                    f"群組／連結資料不合法：{validation_errors}"
                )
            next_layout = layout
            texts_by_id = {
                canonical_id_key(text_label.get("id")): text_label
                for text_label in layout.get("text_labels") or []
            }
            stickers_by_id = {
                canonical_id_key(sticker.get("id")): sticker
                for sticker in layout.get("stickers") or []
            }
            for link in get_material_text_links(layout):
                text_label = texts_by_id.get(canonical_id_key(link.get("text_id")))
                sticker = stickers_by_id.get(canonical_id_key(link.get("material_id")))
                base_row = {
                    "template_id": template.id,
                    "template_name": template.name,
                    "template_page_id": page.id,
                    "page_number": page.page_number + 1,
                    "text_id": link.get("text_id"),
                    "material_id": link.get("material_id"),
                }
                if text_label is None or sticker is None:
                    report_rows.append({
                        **base_row,
                        "status": "missing_endpoint",
                        "reason": "link endpoint 不存在",
                    })
                    continue
                try:
                    suggestion = suggest_material_text_box(
                        database_session,
                        template.id,
                        page.id,
                        sticker_id=sticker.get("id"),
                        path=sticker.get("path", ""),
                        source_revision=sticker.get("asset_revision"),
                        request_token=f"batch-{page.id}-{sticker.get('id')}",
                    )
                except HTTPException as error:
                    detail = error.detail
                    reason = detail.get("code") if isinstance(detail, dict) else str(detail)
                    report_rows.append({
                        **base_row,
                        "status": "error",
                        "reason": reason,
                    })
                    continue
                if suggestion.get("status") != "suggested":
                    report_rows.append({
                        **base_row,
                        "status": "unavailable",
                        "reason": suggestion.get("reason", ""),
                        "confidence": suggestion.get("confidence", ""),
                    })
                    continue

                geometry = project_normalized_box_to_sticker(
                    sticker,
                    suggestion["normalized_box"],
                )
                before_geometry = geometry_for_report(text_label)
                delta = geometry_delta(before_geometry, geometry, sticker)
                status = "changed" if geometry_changed(before_geometry, geometry) else "unchanged"
                if status == "changed":
                    next_layout = update_linked_text_geometry(
                        next_layout,
                        text_label.get("id"),
                        geometry,
                    )
                report_rows.append({
                    **base_row,
                    "status": status,
                    "reason": "",
                    "confidence": suggestion.get("confidence", ""),
                    "review_flag": review_flag(
                        float(suggestion.get("confidence", 0)),
                        delta,
                    ),
                    **{f"old_{field_name}": before_geometry[field_name] for field_name in GEOMETRY_FIELDS},
                    **{f"new_{field_name}": geometry[field_name] for field_name in GEOMETRY_FIELDS},
                    **delta,
                })
            if validate_layout(next_layout):
                raise RuntimeError(
                    f"template_id={template.id} page={page.page_number + 1} 重設後驗證失敗"
                )
            if next_layout != layout:
                changed_pages.append((page.id, page.layout_json))
            page_items.append({
                "id": page.id,
                "client_id": None,
                "layout": next_layout,
            })
        if changed_pages:
            plans.append(TemplateResetPlan(
                template_id=template.id,
                template_name=template.name,
                expected_revision=template.revision,
                expected_page_ids=expected_page_ids,
                page_items=page_items,
                changed_pages=changed_pages,
            ))
    return plans, report_rows


def expected_output_invalidations(
    database_session,
    project_model,
    student_model,
    template_ids: list[int],
) -> int:
    if not template_ids:
        return 0
    return (
        database_session.query(student_model)
        .join(project_model, student_model.project_id == project_model.id)
        .filter(
            project_model.template_id.in_(template_ids),
            student_model.output_filename.isnot(None),
        )
        .count()
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument(
        "--report",
        type=Path,
        help="dry-run 報告基底；實際檔名會自動加 run id",
    )
    parser.add_argument(
        "--run-id",
        type=validate_run_id,
        help="指定本次 run id；預設自動產生唯一值",
    )
    parser.add_argument(
        "--apply-reviewed-manifest",
        type=Path,
        help="套用指定的 review_ready manifest；不會重新執行圖片分析",
    )
    parser.add_argument(
        "--acknowledge-review-flags",
        metavar="PLAN_SHA256",
        help="有 review_flag 時，必須填入該 manifest 的 review_plan_sha256",
    )
    parser.add_argument("--apply", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--force-review-flags",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
    except ValueError as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 2
    if args.apply or args.force_review_flags:
        print(
            "錯誤：直接 --apply/--force-review-flags 已停用；"
            "請先 dry-run 人工審核，再用 --apply-reviewed-manifest",
            file=sys.stderr,
        )
        return 2
    if args.apply_reviewed_manifest and (args.report or args.run_id):
        print(
            "錯誤：套用 reviewed manifest 時不可另給 --report 或 --run-id",
            file=sys.stderr,
        )
        return 2
    if args.acknowledge_review_flags and not args.apply_reviewed_manifest:
        print(
            "錯誤：--acknowledge-review-flags 只可搭配 "
            "--apply-reviewed-manifest",
            file=sys.stderr,
        )
        return 2
    database_path = args.db.resolve()
    if not database_path.is_file():
        print(f"錯誤：找不到資料庫 {database_path}", file=sys.stderr)
        return 2

    run_id = args.run_id or generate_run_id()
    report_base_path = (args.report or DEFAULT_REPORT).resolve()
    report_path = run_scoped_path(report_base_path, run_id)
    manifest_path = manifest_path_for_report(report_base_path, run_id)
    backup_name = f"{MIGRATION_NAME}:{run_id}"
    if args.apply_reviewed_manifest:
        manifest_path = args.apply_reviewed_manifest.resolve()
        if not manifest_path.is_file():
            print(f"錯誤：找不到 manifest {manifest_path}", file=sys.stderr)
            return 2
    elif (
        report_path.exists()
        or manifest_path.exists()
        or backup_name_exists(database_path, backup_name)
    ):
        print(
            f"錯誤：run id={run_id} 的報告、manifest 或備份已存在；"
            "請保留既有產物並使用新的 run id",
            file=sys.stderr,
        )
        return 2

    database_session = None
    manifest = None
    review_plan = None
    review_plan_hash = ""
    reviewed_report_path = None
    reviewed_report_hash = ""
    flagged_counts = {}
    try:
        if args.apply_reviewed_manifest:
            reviewed_manifest = json.loads(
                manifest_path.read_text(encoding="utf-8")
            )
            run_id = validate_run_id(
                str(reviewed_manifest.get("run_id", ""))
            )
            reviewed_database_path = Path(
                str(reviewed_manifest.get("database_path", ""))
            ).resolve()
            if reviewed_database_path != database_path:
                raise ValueError(
                    "manifest 的 database_path 與 --db 不同"
                )
            review_plan, review_plan_hash = validate_review_manifest(
                reviewed_manifest
            )
            flagged_counts = review_plan["analysis"]["review_flag_counts"]
            if (
                flagged_counts
                and args.acknowledge_review_flags != review_plan_hash
            ):
                raise ValueError(
                    "review plan 含需人工確認項目 "
                    f"{flagged_counts}；請以 "
                    "--acknowledge-review-flags "
                    f"{review_plan_hash} 明確確認同一份計畫"
                )
            reviewed_report_path = Path(
                str(reviewed_manifest.get("report_path", ""))
            ).resolve()
            if not reviewed_report_path.is_file():
                raise ValueError(
                    f"找不到原始人工審核報告 {reviewed_report_path}"
                )
            expected_report_hash = reviewed_manifest.get("report_sha256")
            if (
                not isinstance(expected_report_hash, str)
                or len(expected_report_hash) != 64
            ):
                raise ValueError("reviewed manifest 缺少有效的 report SHA-256")
            reviewed_report_hash = file_sha256(reviewed_report_path)
            if reviewed_report_hash != expected_report_hash:
                raise ValueError(
                    "原始人工審核報告 SHA-256 不符，"
                    "CSV 可能已被修改或替換"
                )
            backup_name = str(reviewed_manifest.get("backup_name", ""))
            if backup_name != f"{MIGRATION_NAME}:{run_id}":
                raise ValueError("reviewed manifest 的 backup_name 不符")
            manifest = reviewed_manifest

        (
            project_model,
            session_factory,
            student_model,
            template_model,
            validate_layout,
            project_normalized_box_to_sticker,
            suggest_material_text_box,
            replace_template_pages_snapshot,
        ) = configure_backend(database_path)
        database_session = session_factory()

        if args.apply_reviewed_manifest:
            if backup_name_exists(
                database_path,
                backup_name,
            ):
                raise ValueError(
                    "reviewed manifest 的備份識別已存在或不合法，"
                    "不可重複套用"
                )
            plans = plans_from_review_manifest(
                database_session,
                template_model,
                validate_layout,
                review_plan,
            )
            template_ids = [plan.template_id for plan in plans]
            predicted_invalidations = expected_output_invalidations(
                database_session,
                project_model,
                student_model,
                template_ids,
            )
            review_created_at = manifest.get("started_at")
            review_finished_at = manifest.get("finished_at")
            manifest = build_run_manifest(
                operation=REVIEW_PLAN_OPERATION,
                run_id=run_id,
                database_path=database_path,
                report_path=reviewed_report_path,
                backup_name=backup_name,
                plans=plans,
                apply_requested=True,
            )
            manifest["mode"] = "reviewed-apply"
            manifest["review_created_at"] = review_created_at
            manifest["review_finished_at"] = review_finished_at
            manifest["apply_started_at"] = utc_now_iso()
            manifest["review_plan"] = review_plan
            manifest["review_plan_sha256"] = review_plan_hash
            manifest["report_sha256"] = reviewed_report_hash
            manifest["review_flags_acknowledgement_required"] = bool(
                flagged_counts
            )
            manifest["review_flags_acknowledged"] = (
                review_plan_hash if flagged_counts else None
            )
            write_manifest(manifest_path, manifest)
            invalidated_outputs = 0
            if plans:
                apply_result = apply_template_plans(
                    database_path=database_path,
                    database_session=database_session,
                    template_model=template_model,
                    plans=plans,
                    backup_name=backup_name,
                    manifest=manifest,
                    manifest_path=manifest_path,
                    apply_one=lambda plan, template: replace_template_pages_snapshot(
                        template,
                        plan.expected_page_ids,
                        plan.page_items,
                        database_session,
                        expected_revision=plan.expected_revision,
                    ),
                )
                invalidated_outputs = apply_result.invalidated_output_count
            else:
                finish_manifest(
                    manifest_path,
                    manifest,
                    overall_status="complete",
                )
            print("已套用人工審核的固定幾何計畫；未重新執行圖片分析")
            print(f"預計失效既有輸出：{predicted_invalidations}")
            print(f"實際失效既有輸出：{invalidated_outputs}")
            print(f"run id：{run_id}")
            print(f"manifest：{manifest_path}")
            return 0

        plans, report_rows = build_reset_plans(
            database_session,
            template_model,
            validate_layout,
            project_normalized_box_to_sticker,
            suggest_material_text_box,
        )
        status_counts: dict[str, int] = {}
        for row in report_rows:
            status = row["status"]
            status_counts[status] = status_counts.get(status, 0) + 1
        blocking_counts = blocking_status_counts(report_rows)
        flagged_counts = review_flag_counts(report_rows)
        review_plan = build_review_plan(
            plans,
            blocking_counts=blocking_counts,
            flagged_counts=flagged_counts,
        )
        review_plan_hash = layout_sha256(review_plan)
        write_report(
            report_path,
            report_rows,
            run_id,
            review_plan_hash,
        )
        report_hash = file_sha256(report_path)
        manifest = build_run_manifest(
            operation=REVIEW_PLAN_OPERATION,
            run_id=run_id,
            database_path=database_path,
            report_path=report_path,
            backup_name=backup_name,
            plans=plans,
            apply_requested=False,
        )
        manifest["mode"] = "review-plan"
        manifest["review_plan"] = review_plan
        manifest["review_plan_sha256"] = review_plan_hash
        manifest["report_sha256"] = report_hash
        manifest["review_flags_acknowledgement_required"] = bool(
            flagged_counts
        )
        template_ids = [plan.template_id for plan in plans]
        predicted_invalidations = expected_output_invalidations(
            database_session,
            project_model,
            student_model,
            template_ids,
        )
        if blocking_counts:
            finish_manifest(
                manifest_path,
                manifest,
                overall_status="blocked_analysis",
                error=f"分析含不可套用項目 {blocking_counts}",
            )
        else:
            finish_manifest(
                manifest_path,
                manifest,
                overall_status="review_ready",
            )
        print(f"分析結果：{status_counts}（dry-run，未寫入）")
        print(f"需人工確認：{flagged_counts}")
        print(f"預計失效既有輸出：{predicted_invalidations}")
        print(f"run id：{run_id}")
        print(f"報告：{report_path}")
        print(f"manifest：{manifest_path}")
        print(f"review plan SHA-256：{review_plan_hash}")
        if blocking_counts:
            print(
                f"分析含不可套用項目 {blocking_counts}，此 manifest 不可套用",
                file=sys.stderr,
            )
            return 2
        print(
            "人工審核後套用：python "
            "scripts/reset_linked_material_text_boxes.py "
            f"--db \"{database_path}\" "
            f"--apply-reviewed-manifest \"{manifest_path}\""
        )
        if flagged_counts:
            print(
                "並加上：--acknowledge-review-flags "
                f"{review_plan_hash}"
            )
        return 0
    except PartialApplyError as error:
        print(
            "錯誤：整批不是單一 transaction；"
            f"已成功模板 {error.applied_template_ids}，"
            f"失敗模板 {error.failed_template_id}。{error}",
            file=sys.stderr,
        )
        print(f"run id：{run_id}", file=sys.stderr)
        print(f"manifest：{error.manifest_path}", file=sys.stderr)
        return 2
    except (
        HTTPException,
        OSError,
        RuntimeError,
        ValueError,
        json.JSONDecodeError,
        sqlite3.DatabaseError,
    ) as error:
        if database_session is not None:
            database_session.rollback()
        if manifest is not None and manifest.get("finished_at") is None:
            finish_manifest(
                manifest_path,
                manifest,
                overall_status="failed",
                error=str(error),
            )
        print(f"錯誤：{error}", file=sys.stderr)
        print(f"run id：{run_id}", file=sys.stderr)
        if manifest is not None:
            print(f"manifest：{manifest_path}", file=sys.stderr)
        return 2
    finally:
        if database_session is not None:
            database_session.close()


if __name__ == "__main__":
    raise SystemExit(main())
