"""為既有模板回填可安全判定的素材文字連結。

只連結「老師可填文字」與貼圖，不修改文字、貼圖、位置、尺寸、字級或圖層順序。
配對必須同時符合：

- 文字框四個旋轉後角點都落在唯一一張貼圖框內
- 文字圖層位於貼圖上方
- 同一張貼圖只對應一個文字框

預設只產生報告；加上 ``--apply`` 才寫入。寫入前會把原始 layout_json 保存到
``template_page_layout_migration_backups``，且模板更新走正式 snapshot/sync service，
讓 Template／Project revision 一致前進。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

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
    manifest_path_for_report,
    run_scoped_path,
    validate_run_id,
    write_csv,
    write_manifest,
)

DEFAULT_DATABASE = BACKEND_DIR / "album_maker.db"
DEFAULT_REPORT = ROOT_DIR / "output" / "material-text-link-report.csv"
MIGRATION_NAME = "material_text_links_backfill_2026_07"
MATERIAL_TEXT_LINK_KIND = "material-text-v1"
NESTED_GROUP_CONTRACT = "nested-world-v2"
FLAT_GROUP_CONTRACT = "flat-world-v1"


@dataclass(frozen=True)
class LinkPair:
    material_id: Any
    text_id: Any


@dataclass
class TemplateBackfillPlan:
    template_id: int
    template_name: str
    expected_revision: int
    expected_page_ids: list[int]
    page_items: list[dict]
    changed_pages: list[tuple[int, str]]


def canonical_id_key(value: Any) -> str:
    """比照 layout contract，把整數型數字與同值字串視為同一 ID。"""
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)) and math.isfinite(float(value)) and float(value).is_integer():
        return str(int(value))
    return str(value)


def is_fillable_text_label(label: dict) -> bool:
    role = label.get("text_role", label.get("textRole"))
    return role != "static" and label.get("editable") is not False


def rotated_corners(element: dict) -> list[tuple[float, float]]:
    x_value = float(element.get("x", 0))
    y_value = float(element.get("y", 0))
    width = float(element.get("width", 0))
    height = float(element.get("height", 0))
    center_x = x_value + width / 2
    center_y = y_value + height / 2
    angle = math.radians(float(element.get("rotation", 0) or 0))
    corners = []
    for offset_x, offset_y in (
        (-width / 2, -height / 2),
        (width / 2, -height / 2),
        (width / 2, height / 2),
        (-width / 2, height / 2),
    ):
        corners.append((
            center_x + offset_x * math.cos(angle) - offset_y * math.sin(angle),
            center_y + offset_x * math.sin(angle) + offset_y * math.cos(angle),
        ))
    return corners


def point_inside_rotated_rect(point: tuple[float, float], rectangle: dict) -> bool:
    width = float(rectangle.get("width", 0))
    height = float(rectangle.get("height", 0))
    if width <= 0 or height <= 0:
        return False
    center_x = float(rectangle.get("x", 0)) + width / 2
    center_y = float(rectangle.get("y", 0)) + height / 2
    inverse_angle = -math.radians(float(rectangle.get("rotation", 0) or 0))
    delta_x = point[0] - center_x
    delta_y = point[1] - center_y
    local_x = delta_x * math.cos(inverse_angle) - delta_y * math.sin(inverse_angle)
    local_y = delta_x * math.sin(inverse_angle) + delta_y * math.cos(inverse_angle)
    epsilon = 0.001
    return (
        abs(local_x) <= width / 2 + epsilon
        and abs(local_y) <= height / 2 + epsilon
    )


def is_safe_material_text_candidate(
    text_label: dict,
    text_render_order: int,
    sticker: dict,
    sticker_render_order: int,
) -> bool:
    if not sticker.get("path"):
        return False
    text_width = float(text_label.get("width", 0))
    text_height = float(text_label.get("height", 0))
    sticker_width = float(sticker.get("width", 0))
    sticker_height = float(sticker.get("height", 0))
    if min(text_width, text_height, sticker_width, sticker_height) <= 0:
        return False
    if text_width * text_height > sticker_width * sticker_height:
        return False
    if sticker_render_order >= text_render_order:
        return False
    return all(
        point_inside_rotated_rect(corner, sticker)
        for corner in rotated_corners(text_label)
    )


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


def _official_render_elements(layout: dict):
    """使用正式 renderer traversal，含 ancestor visibility 與群組排序。"""
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    from services.layout_group_traversal import iter_layout_render_elements

    return iter_layout_render_elements(layout, malformed_fallback=False)


def _v1_group_index_for_pair(layout: dict, pair: LinkPair) -> int | None:
    material_key = canonical_id_key(pair.material_id)
    text_key = canonical_id_key(pair.text_id)
    for group_index, group in enumerate(layout.get("groups") or []):
        if not isinstance(group, dict):
            continue
        child_keys = {
            (child.get("type"), canonical_id_key(child.get("id")))
            for child in (group.get("children") or [])
            if isinstance(child, dict)
        }
        if (
            ("sticker", material_key) in child_keys
            and ("text", text_key) in child_keys
        ):
            return group_index
    return None


def can_persist_material_text_pair(layout: dict, pair: LinkPair) -> bool:
    groups = layout.get("groups") or []
    if layout.get("group_contract") != FLAT_GROUP_CONTRACT or not groups:
        return True
    return _v1_group_index_for_pair(layout, pair) is not None


def find_safe_material_text_pairs(
    layout: dict,
    iter_render_elements: Callable[[dict], Any] | None = None,
) -> tuple[list[LinkPair], list[dict]]:
    render_iterator = iter_render_elements or _official_render_elements
    effective_elements = list(render_iterator(layout))
    visible_texts: dict[str, tuple[int, dict]] = {}
    visible_stickers: list[tuple[int, dict]] = []
    for render_order, (element_type, element, _element_index) in enumerate(
        effective_elements
    ):
        if element_type == "text":
            visible_texts.setdefault(
                canonical_id_key(element.get("id")),
                (render_order, element),
            )
        elif element_type == "sticker":
            visible_stickers.append((render_order, element))

    text_labels = [
        label
        for label in (layout.get("text_labels") or [])
        if isinstance(label, dict)
    ]
    existing_links = [
        link for link in get_material_text_links(layout)
        if link.get("kind") == MATERIAL_TEXT_LINK_KIND
    ]
    linked_text_ids = {
        canonical_id_key(link.get("text_id"))
        for link in existing_links
    }
    linked_material_ids = {
        canonical_id_key(link.get("material_id"))
        for link in existing_links
    }

    report_rows = []
    candidate_materials_by_text: dict[str, list[dict]] = {}
    text_by_key: dict[str, dict] = {}
    for text_label in text_labels:
        text_key = canonical_id_key(text_label.get("id"))
        text_by_key[text_key] = text_label
        if not is_fillable_text_label(text_label):
            report_rows.append({
                "status": "skipped_static",
                "text_id": text_label.get("id"),
                "material_id": "",
                "reason": "固定文字不建立素材連結",
            })
            continue
        visible_text = visible_texts.get(text_key)
        if visible_text is None:
            report_rows.append({
                "status": "skipped_hidden",
                "text_id": text_label.get("id"),
                "material_id": "",
                "reason": "文字本身或 ancestor 群組隱藏，不自動建立素材連結",
            })
            continue
        if text_key in linked_text_ids:
            existing_link = next(
                link for link in existing_links
                if canonical_id_key(link.get("text_id")) == text_key
            )
            report_rows.append({
                "status": "existing",
                "text_id": text_label.get("id"),
                "material_id": existing_link.get("material_id"),
                "reason": "既有連結保留",
            })
            continue
        text_render_order, effective_text_label = visible_text
        candidate_materials_by_text[text_key] = [
            sticker
            for sticker_render_order, sticker in visible_stickers
            if canonical_id_key(sticker.get("id")) not in linked_material_ids
            and is_safe_material_text_candidate(
                effective_text_label,
                text_render_order,
                sticker,
                sticker_render_order,
            )
        ]

    candidate_texts_by_material: dict[str, list[str]] = {}
    for text_key, candidate_materials in candidate_materials_by_text.items():
        for sticker in candidate_materials:
            material_key = canonical_id_key(sticker.get("id"))
            candidate_texts_by_material.setdefault(material_key, []).append(text_key)

    planned_pairs = []
    for text_key, candidate_materials in candidate_materials_by_text.items():
        text_label = text_by_key[text_key]
        if not candidate_materials:
            report_rows.append({
                "status": "unmatched",
                "text_id": text_label.get("id"),
                "material_id": "",
                "reason": "沒有完整包住文字框的唯一貼圖",
            })
            continue
        if len(candidate_materials) > 1:
            report_rows.append({
                "status": "ambiguous",
                "text_id": text_label.get("id"),
                "material_id": "",
                "reason": f"同時符合 {len(candidate_materials)} 張貼圖",
            })
            continue
        sticker = candidate_materials[0]
        material_key = canonical_id_key(sticker.get("id"))
        if len(candidate_texts_by_material.get(material_key, [])) > 1:
            report_rows.append({
                "status": "ambiguous",
                "text_id": text_label.get("id"),
                "material_id": sticker.get("id"),
                "reason": "同一貼圖同時符合多個文字框",
            })
            continue
        pair = LinkPair(material_id=sticker.get("id"), text_id=text_label.get("id"))
        if not can_persist_material_text_pair(layout, pair):
            report_rows.append({
                "status": "unsupported_v1_scope",
                "text_id": text_label.get("id"),
                "material_id": sticker.get("id"),
                "reason": "flat-world-v1 只允許同一群組內的素材文字連結",
            })
            continue
        planned_pairs.append(pair)
        report_rows.append({
            "status": "planned",
            "text_id": pair.text_id,
            "material_id": pair.material_id,
            "reason": "安全配對",
        })
    return planned_pairs, report_rows


def add_material_text_links(layout: dict, pairs: list[LinkPair]) -> dict:
    if not pairs:
        return layout
    next_layout = deepcopy(layout)
    if (
        next_layout.get("group_contract") == FLAT_GROUP_CONTRACT
        and next_layout.get("groups")
    ):
        next_groups = list(next_layout["groups"])
        for pair in pairs:
            group_index = _v1_group_index_for_pair(next_layout, pair)
            if group_index is None:
                raise ValueError(
                    "flat-world-v1 連結 endpoint 必須位於同一個群組"
                )
            next_group = dict(next_groups[group_index])
            links = [
                link
                for link in (next_group.get("links") or [])
                if isinstance(link, dict)
            ]
            pair_key = (
                canonical_id_key(pair.material_id),
                canonical_id_key(pair.text_id),
            )
            existing_pair_keys = {
                (
                    canonical_id_key(link.get("material_id")),
                    canonical_id_key(link.get("text_id")),
                )
                for link in links
                if link.get("kind") == MATERIAL_TEXT_LINK_KIND
            }
            if pair_key not in existing_pair_keys:
                links.append({
                    "kind": MATERIAL_TEXT_LINK_KIND,
                    "material_id": pair.material_id,
                    "text_id": pair.text_id,
                })
            next_group["links"] = links
            next_groups[group_index] = next_group
        next_layout["groups"] = next_groups
        return next_layout

    links = [
        link
        for link in (next_layout.get("material_text_links") or [])
        if isinstance(link, dict)
    ]
    existing_pair_keys = {
        (
            canonical_id_key(link.get("material_id")),
            canonical_id_key(link.get("text_id")),
        )
        for link in links
        if link.get("kind") == MATERIAL_TEXT_LINK_KIND
    }
    for pair in pairs:
        pair_key = (canonical_id_key(pair.material_id), canonical_id_key(pair.text_id))
        if pair_key not in existing_pair_keys:
            links.append({
                "kind": MATERIAL_TEXT_LINK_KIND,
                "material_id": pair.material_id,
                "text_id": pair.text_id,
            })
            existing_pair_keys.add(pair_key)
    next_layout["group_contract"] = NESTED_GROUP_CONTRACT
    next_layout["material_text_links"] = links
    return next_layout


def write_report(report_path: Path, rows: list[dict], run_id: str) -> None:
    fieldnames = [
        "run_id",
        "template_id",
        "template_name",
        "page_number",
        "template_page_id",
        "status",
        "text_id",
        "material_id",
        "reason",
    ]
    write_csv(
        report_path,
        fieldnames,
        ({**row, "run_id": run_id} for row in rows),
    )


def configure_backend(database_path: Path):
    os.environ["DATABASE_URL"] = f"sqlite:///{database_path.resolve().as_posix()}"
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    from database import SessionLocal, Template
    from services.layout_group_traversal import layout_for_render_fingerprint
    from services.layout_group_validation import validate_layout_groups
    from services.template_page_snapshot_service import replace_template_pages_snapshot

    return (
        SessionLocal,
        Template,
        layout_for_render_fingerprint,
        validate_layout_groups,
        replace_template_pages_snapshot,
    )


def build_backfill_plans(
    database_session,
    template_model,
    fingerprint_layout: Callable[[dict], dict],
    validate_layout: Callable[[dict], list[dict]],
) -> tuple[list[TemplateBackfillPlan], list[dict]]:
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
                    f"template_id={template.id} page={page.page_number + 1} 群組／連結資料不合法："
                    f"{validation_errors}"
                )
            pairs, page_report_rows = find_safe_material_text_pairs(layout)
            for row in page_report_rows:
                report_rows.append({
                    "template_id": template.id,
                    "template_name": template.name,
                    "page_number": page.page_number + 1,
                    "template_page_id": page.id,
                    **row,
                })
            next_layout = add_material_text_links(layout, pairs)
            if validate_layout(next_layout):
                raise RuntimeError(
                    f"template_id={template.id} page={page.page_number + 1} 回填後驗證失敗"
                )
            if next_layout != layout:
                if fingerprint_layout(next_layout) != fingerprint_layout(layout):
                    raise RuntimeError(
                        f"template_id={template.id} page={page.page_number + 1} "
                        "素材連結意外改變 render fingerprint"
                    )
                changed_pages.append((page.id, page.layout_json))
            page_items.append({
                "id": page.id,
                "client_id": None,
                "layout": next_layout,
            })
        if changed_pages:
            plans.append(TemplateBackfillPlan(
                template_id=template.id,
                template_name=template.name,
                expected_revision=template.revision,
                expected_page_ids=expected_page_ids,
                page_items=page_items,
                changed_pages=changed_pages,
            ))
    return plans, report_rows


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument(
        "--report",
        type=Path,
        default=DEFAULT_REPORT,
        help="報告基底；實際檔名會自動加 run id",
    )
    parser.add_argument(
        "--run-id",
        type=validate_run_id,
        help="指定本次 run id；預設自動產生唯一值",
    )
    parser.add_argument("--apply", action="store_true", help="真正寫入；不加時只產生報告")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
    except ValueError as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 2
    database_path = args.db.resolve()
    if not database_path.is_file():
        print(f"錯誤：找不到資料庫 {database_path}", file=sys.stderr)
        return 2
    run_id = args.run_id or generate_run_id()
    report_base_path = args.report.resolve()
    report_path = run_scoped_path(report_base_path, run_id)
    manifest_path = manifest_path_for_report(report_base_path, run_id)
    backup_name = f"{MIGRATION_NAME}:{run_id}"
    if (
        report_path.exists()
        or manifest_path.exists()
        or (
            args.apply
            and backup_name_exists(database_path, backup_name)
        )
    ):
        print(
            f"錯誤：run id={run_id} 的報告、manifest 或備份已存在；"
            "請保留既有產物並使用新的 run id",
            file=sys.stderr,
        )
        return 2

    (
        session_factory,
        template_model,
        fingerprint_layout,
        validate_layout,
        replace_template_pages_snapshot,
    ) = configure_backend(database_path)
    database_session = session_factory()
    manifest = None
    try:
        plans, report_rows = build_backfill_plans(
            database_session,
            template_model,
            fingerprint_layout,
            validate_layout,
        )
        write_report(report_path, report_rows, run_id)
        manifest = build_run_manifest(
            operation="backfill_material_text_links",
            run_id=run_id,
            database_path=database_path,
            report_path=report_path,
            backup_name=backup_name,
            plans=plans,
            apply_requested=args.apply,
        )
        write_manifest(manifest_path, manifest)
        planned_count = sum(row["status"] == "planned" for row in report_rows)
        existing_count = sum(row["status"] == "existing" for row in report_rows)
        unmatched_count = sum(row["status"] == "unmatched" for row in report_rows)
        ambiguous_count = sum(row["status"] == "ambiguous" for row in report_rows)
        unsupported_v1_count = sum(
            row["status"] == "unsupported_v1_scope"
            for row in report_rows
        )
        if args.apply and plans:
            apply_template_plans(
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
                require_zero_invalidations=True,
            )
        elif args.apply:
            finish_manifest(
                manifest_path,
                manifest,
                overall_status="complete",
            )
        else:
            finish_manifest(
                manifest_path,
                manifest,
                overall_status="dry_run",
            )
        mode = "已寫入" if args.apply else "dry-run，未寫入"
        print(
            f"安全配對新增 {planned_count}、既有 {existing_count}、"
            f"無候選 {unmatched_count}、歧義 {ambiguous_count}、"
            f"v1 跨群組略過 {unsupported_v1_count}（{mode}）"
        )
        print(f"run id：{run_id}")
        print(f"報告：{report_path}")
        print(f"manifest：{manifest_path}")
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
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, sqlite3.DatabaseError) as error:
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
        database_session.close()


if __name__ == "__main__":
    raise SystemExit(main())
