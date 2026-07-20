"""依正式 Pillow 排版結果列出超出文字框的實際文字項目。

預設檢查未封存專案、正式列印 2480×3508 尺寸，並分別輸出逐學生明細與
template/page/label 彙總。只讀資料庫，不修改模板、專案或學生資料。
"""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from PIL import Image

ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scripts.data_script_utils import (
    generate_run_id,
    run_scoped_path,
    validate_run_id,
    write_csv,
)
from services.draw_helpers import get_font
from services.element_renderers import render_text_label
from services.label_texts import get_label_entry_text, merge_project_label_texts_into_pages
from services.layout_group_traversal import iter_layout_render_elements
from services.render_service import PRINT_OUTPUT_SIZE, scale_layout_to_size
from services.text_layout import TEXT_LAYOUT_MEASUREMENT_SCALE, layout_text_label
from services.text_variables import (
    ALBUM_NAME_PREVIEW_PLACEHOLDER,
    FULL_NAME_PREVIEW_PLACEHOLDER,
    resolve_student_text_variables,
)

DEFAULT_DATABASE = BACKEND_DIR / "album_maker.db"
DEFAULT_DETAIL_REPORT = ROOT_DIR / "output" / "text-overflow-details.csv"
DEFAULT_SUMMARY_REPORT = ROOT_DIR / "output" / "text-overflow-summary.csv"


def is_fillable_text_label(label: dict) -> bool:
    role = label.get("text_role", label.get("textRole"))
    return role != "static" and label.get("editable") is not False


def effective_label_text(
    label: dict,
    label_entry: Any,
    student_name: str,
    album_name: str | None = None,
) -> str:
    raw_text = get_label_entry_text(label_entry) if is_fillable_text_label(label) else None
    if raw_text is None:
        raw_text = label.get("text", "")
    return resolve_student_text_variables(raw_text, student_name, album_name)


def measure_text_overflow(
    label: dict,
    label_entry: Any,
    student_name: str,
    album_name: str | None = None,
) -> dict | None:
    resolved_text = effective_label_text(
        label,
        label_entry,
        student_name,
        album_name,
    )
    if not resolved_text:
        return None

    font_size = float(label.get("font_size", 24))
    box_width = max(1, int(round(float(label.get("width", 1)))))
    box_height = max(1, int(round(float(label.get("height", 1)))))
    source = label.get("_text_layout_source")
    if not isinstance(source, dict):
        source = label
    source_font_size = float(source.get("font_size", font_size))
    measurement_scale = TEXT_LAYOUT_MEASUREMENT_SCALE
    source_font = get_font(
        source_font_size * measurement_scale,
        source.get("font_family"),
    )
    layout_plan = layout_text_label(
        resolved_text,
        font=source_font,
        box_width=float(source.get("width", box_width)) * measurement_scale,
        box_height=float(source.get("height", box_height)) * measurement_scale,
        font_size=source_font_size * measurement_scale,
        line_height=float(source.get("line_height", label.get("line_height", 1.4))),
        letter_spacing=(
            float(source.get("letter_spacing", label.get("letter_spacing", 0)))
            * measurement_scale
        ),
        text_align=label.get("text_align", "center"),
        clip_overflow=False,
    )
    total_line_height = (
        len(layout_plan.full_lines)
        * layout_plan.line_height_px
        / measurement_scale
    )
    scaled_line_height = total_line_height * (
        box_height / float(source.get("height", box_height))
    )

    horizontal_margin = max(128, math.ceil(font_size * 4))
    vertical_margin = max(
        128,
        math.ceil(abs(scaled_line_height - box_height) / 2 + font_size * 4),
    )
    canvas = Image.new(
        "RGBA",
        (
            box_width + horizontal_margin * 2,
            box_height + vertical_margin * 2,
        ),
        (0, 0, 0, 0),
    )
    audit_label = {
        **label,
        "x": horizontal_margin,
        "y": vertical_margin,
        # 旋轉不改變文字相對自身 local frame 是否溢出；歸零後可精確量四方向。
        "rotation": 0,
        "font_color": "#000000",
        "text_shadow_enabled": False,
    }
    audit_entry = label_entry if is_fillable_text_label(label) else None
    render_text_label(
        canvas,
        audit_label,
        {str(label.get("id", "")): audit_entry},
        student_name,
        album_name=album_name,
        clip_overflow=False,
    )
    glyph_bbox = canvas.getbbox()
    if glyph_bbox is None:
        return None

    box_left = horizontal_margin
    box_top = vertical_margin
    box_right = box_left + box_width
    box_bottom = box_top + box_height
    overflow_left = max(0, box_left - glyph_bbox[0])
    overflow_top = max(0, box_top - glyph_bbox[1])
    overflow_right = max(0, glyph_bbox[2] - box_right)
    overflow_bottom = max(0, glyph_bbox[3] - box_bottom)
    return {
        "resolved_text": resolved_text,
        "text_length": len(resolved_text),
        "line_count": len(layout_plan.full_lines),
        "line_box_risk": total_line_height > float(source.get("height", box_height)),
        "box_width_px": box_width,
        "box_height_px": box_height,
        "glyph_left": glyph_bbox[0] - box_left,
        "glyph_top": glyph_bbox[1] - box_top,
        "glyph_right": glyph_bbox[2] - box_left,
        "glyph_bottom": glyph_bbox[3] - box_top,
        "overflow_left_px": overflow_left,
        "overflow_top_px": overflow_top,
        "overflow_right_px": overflow_right,
        "overflow_bottom_px": overflow_bottom,
        "has_overflow": any((
            overflow_left,
            overflow_top,
            overflow_right,
            overflow_bottom,
        )),
    }


def parse_json(raw_value: str | None, fallback):
    if not raw_value:
        return fallback
    return json.loads(raw_value)


def label_source_scope(
    page_index: int,
    label_id: Any,
    project_label_texts: dict,
    student_pages_by_index: dict[int, dict],
) -> str:
    label_key = str(label_id)
    student_labels = (student_pages_by_index.get(page_index) or {}).get("label_texts") or {}
    if isinstance(student_labels, dict) and label_key in student_labels:
        return "student"
    project_labels = project_label_texts.get(str(page_index), {})
    if isinstance(project_labels, dict) and label_key in project_labels:
        return "project"
    return "template"


def collect_template_defaults(connection: sqlite3.Connection, mode: str) -> tuple[int, list[dict]]:
    checked_count = 0
    overflow_rows = []
    pages = connection.execute(
        """SELECT template_pages.id AS template_page_id,
                  template_pages.template_id,
                  templates.name AS template_name,
                  template_pages.page_number,
                  template_pages.layout_json
           FROM template_pages
           JOIN templates ON templates.id = template_pages.template_id
           ORDER BY template_pages.template_id, template_pages.page_number"""
    ).fetchall()
    for page in pages:
        layout = json.loads(page["layout_json"])
        audit_layout = (
            scale_layout_to_size(layout, PRINT_OUTPUT_SIZE)
            if mode == "print"
            else layout
        )
        for element_type, label, _ in iter_layout_render_elements(audit_layout):
            if element_type != "text":
                continue
            measurement = measure_text_overflow(
                label,
                None,
                FULL_NAME_PREVIEW_PLACEHOLDER,
                ALBUM_NAME_PREVIEW_PLACEHOLDER,
            )
            if measurement is None:
                continue
            checked_count += 1
            if not measurement["has_overflow"]:
                continue
            overflow_rows.append({
                "template_id": page["template_id"],
                "template_name": page["template_name"],
                "template_page_id": page["template_page_id"],
                "page_number": page["page_number"] + 1,
                "label_id": label.get("id"),
                "project_id": "",
                "project_name": "",
                "student_id": "",
                "student_name": "",
                "source_scope": "template",
                **measurement,
            })
    return checked_count, overflow_rows


def collect_project_instances(
    connection: sqlite3.Connection,
    scope: str,
    mode: str,
) -> tuple[int, list[dict]]:
    page_rows = connection.execute(
        """SELECT template_pages.id AS template_page_id,
                  template_pages.template_id,
                  templates.name AS template_name,
                  template_pages.page_number,
                  template_pages.layout_json
           FROM template_pages
           JOIN templates ON templates.id = template_pages.template_id
           ORDER BY template_pages.template_id, template_pages.page_number"""
    ).fetchall()
    pages_by_template: dict[int, list[dict]] = defaultdict(list)
    for page in page_rows:
        pages_by_template[page["template_id"]].append({
            "template_page_id": page["template_page_id"],
            "template_name": page["template_name"],
            "page_number": page["page_number"],
            "layout": json.loads(page["layout_json"]),
        })

    project_filter = "" if scope == "all" else "WHERE projects.deleted_at IS NULL"
    projects = connection.execute(
        f"""SELECT projects.id, projects.name, projects.template_id,
                   projects.label_texts_json
            FROM projects
            {project_filter}
            ORDER BY projects.id"""
    ).fetchall()
    checked_count = 0
    overflow_rows = []
    for project in projects:
        page_records = pages_by_template.get(project["template_id"], [])
        if not page_records:
            continue
        project_label_texts = parse_json(project["label_texts_json"], {})
        page_layouts = [page_record["layout"] for page_record in page_records]
        students = connection.execute(
            """SELECT student.id, student.name,
                      CASE
                          WHEN project.classroom_id IS NOT NULL
                          THEN child.album_name
                          ELSE student.album_name
                      END AS album_name,
                      student.pages_data_json
               FROM students AS student
               JOIN projects AS project ON project.id = student.project_id
               LEFT JOIN roster_children AS child
                   ON child.id = student.roster_child_id
               WHERE student.project_id = ?
               ORDER BY student.id""",
            (project["id"],),
        ).fetchall()
        for student in students:
            student_pages = parse_json(student["pages_data_json"], [])
            student_pages_by_index = {
                int(page_data.get("page_index", 0)): page_data
                for page_data in student_pages
                if isinstance(page_data, dict)
            }
            merged_pages = merge_project_label_texts_into_pages(
                student_pages,
                project_label_texts,
                page_layouts,
            )
            merged_pages_by_index = {
                int(page_data.get("page_index", 0)): page_data
                for page_data in merged_pages
                if isinstance(page_data, dict)
            }
            for page_index, page_record in enumerate(page_records):
                page_data = merged_pages_by_index.get(page_index) or {
                    "photos": {},
                    "label_texts": {},
                }
                if page_data.get("skip") is True:
                    continue
                audit_layout = (
                    scale_layout_to_size(page_record["layout"], PRINT_OUTPUT_SIZE)
                    if mode == "print"
                    else page_record["layout"]
                )
                page_label_texts = page_data.get("label_texts") or {}
                for element_type, label, _ in iter_layout_render_elements(audit_layout):
                    if element_type != "text":
                        continue
                    label_entry = (
                        page_label_texts.get(str(label.get("id")))
                        if is_fillable_text_label(label)
                        else None
                    )
                    measurement = measure_text_overflow(
                        label,
                        label_entry,
                        student["name"],
                        student["album_name"],
                    )
                    if measurement is None:
                        continue
                    checked_count += 1
                    if not measurement["has_overflow"]:
                        continue
                    overflow_rows.append({
                        "template_id": project["template_id"],
                        "template_name": page_record["template_name"],
                        "template_page_id": page_record["template_page_id"],
                        "page_number": page_record["page_number"] + 1,
                        "label_id": label.get("id"),
                        "project_id": project["id"],
                        "project_name": project["name"],
                        "student_id": student["id"],
                        "student_name": student["name"],
                        "source_scope": label_source_scope(
                            page_index,
                            label.get("id"),
                            project_label_texts,
                            student_pages_by_index,
                        ),
                        **measurement,
                    })
    return checked_count, overflow_rows


def summarize_overflow_rows(rows: list[dict]) -> list[dict]:
    summary_by_label: dict[tuple, dict] = {}
    for row in rows:
        key = (
            row["template_id"],
            row["template_page_id"],
            str(row["label_id"]),
        )
        summary = summary_by_label.setdefault(key, {
            "template_id": row["template_id"],
            "template_name": row["template_name"],
            "template_page_id": row["template_page_id"],
            "page_number": row["page_number"],
            "label_id": row["label_id"],
            "overflow_instance_count": 0,
            "project_ids": set(),
            "project_names": set(),
            "student_ids": set(),
            "max_text_length": 0,
            "max_overflow_left_px": 0,
            "max_overflow_top_px": 0,
            "max_overflow_right_px": 0,
            "max_overflow_bottom_px": 0,
        })
        summary["overflow_instance_count"] += 1
        if row["project_id"] != "":
            summary["project_ids"].add(row["project_id"])
            summary["project_names"].add(row["project_name"])
        if row["student_id"] != "":
            summary["student_ids"].add(row["student_id"])
        summary["max_text_length"] = max(summary["max_text_length"], row["text_length"])
        for direction in ("left", "top", "right", "bottom"):
            field_name = f"max_overflow_{direction}_px"
            summary[field_name] = max(
                summary[field_name],
                row[f"overflow_{direction}_px"],
            )

    output = []
    for summary in summary_by_label.values():
        output.append({
            "template_id": summary["template_id"],
            "template_name": summary["template_name"],
            "template_page_id": summary["template_page_id"],
            "page_number": summary["page_number"],
            "label_id": summary["label_id"],
            "overflow_instance_count": summary["overflow_instance_count"],
            "project_count": len(summary["project_ids"]),
            "project_names": "、".join(sorted(summary["project_names"])),
            "student_count": len(summary["student_ids"]),
            "max_text_length": summary["max_text_length"],
            "max_overflow_left_px": summary["max_overflow_left_px"],
            "max_overflow_top_px": summary["max_overflow_top_px"],
            "max_overflow_right_px": summary["max_overflow_right_px"],
            "max_overflow_bottom_px": summary["max_overflow_bottom_px"],
        })
    return sorted(
        output,
        key=lambda row: (
            row["template_id"],
            row["page_number"],
            str(row["label_id"]),
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument(
        "--scope",
        choices=("active", "all", "template-defaults"),
        default="active",
    )
    parser.add_argument("--mode", choices=("base", "print"), default="print")
    parser.add_argument("--detail-report", type=Path, default=DEFAULT_DETAIL_REPORT)
    parser.add_argument("--summary-report", type=Path, default=DEFAULT_SUMMARY_REPORT)
    parser.add_argument(
        "--run-id",
        type=validate_run_id,
        help="指定本次 run id；預設自動產生唯一值",
    )
    parser.add_argument("--include-text", action="store_true")
    parser.add_argument("--fail-on-overflow", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    database_path = args.db.resolve()
    if not database_path.is_file():
        print(f"錯誤：找不到資料庫 {database_path}", file=sys.stderr)
        return 2
    run_id = args.run_id or generate_run_id()
    detail_report_path = run_scoped_path(
        args.detail_report.resolve(),
        run_id,
    )
    summary_report_path = run_scoped_path(
        args.summary_report.resolve(),
        run_id,
    )
    if detail_report_path == summary_report_path:
        print("錯誤：明細與彙總報告不可使用同一路徑", file=sys.stderr)
        return 2
    existing_reports = [
        report_path
        for report_path in (detail_report_path, summary_report_path)
        if report_path.exists()
    ]
    if existing_reports:
        print(
            f"錯誤：run id={run_id} 的報告已存在：{existing_reports}",
            file=sys.stderr,
        )
        return 2
    try:
        connection = sqlite3.connect(
            f"file:{database_path.as_posix()}?mode=ro",
            uri=True,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN")
        if args.scope == "template-defaults":
            checked_count, overflow_rows = collect_template_defaults(
                connection,
                args.mode,
            )
        else:
            checked_count, overflow_rows = collect_project_instances(
                connection,
                args.scope,
                args.mode,
            )
        connection.rollback()
        connection.close()

        detail_fields = [
            "run_id",
            "template_id",
            "template_name",
            "template_page_id",
            "page_number",
            "label_id",
            "project_id",
            "project_name",
            "student_id",
            "student_name",
            "source_scope",
            "text_length",
            "line_count",
            "line_box_risk",
            "box_width_px",
            "box_height_px",
            "glyph_left",
            "glyph_top",
            "glyph_right",
            "glyph_bottom",
            "overflow_left_px",
            "overflow_top_px",
            "overflow_right_px",
            "overflow_bottom_px",
        ]
        if args.include_text:
            detail_fields.append("resolved_text")
        write_csv(
            detail_report_path,
            detail_fields,
            ({**row, "run_id": run_id} for row in overflow_rows),
        )
        summary_rows = summarize_overflow_rows(overflow_rows)
        summary_fields = [
            "run_id",
            "template_id",
            "template_name",
            "template_page_id",
            "page_number",
            "label_id",
            "overflow_instance_count",
            "project_count",
            "project_names",
            "student_count",
            "max_text_length",
            "max_overflow_left_px",
            "max_overflow_top_px",
            "max_overflow_right_px",
            "max_overflow_bottom_px",
        ]
        write_csv(
            summary_report_path,
            summary_fields,
            ({**row, "run_id": run_id} for row in summary_rows),
        )
        print(
            f"檢查 {checked_count} 個非空文字實例，"
            f"{len(overflow_rows)} 個實際 glyph 溢框，"
            f"涉及 {len(summary_rows)} 個模板文字框"
        )
        print(f"run id：{run_id}")
        print(f"明細：{detail_report_path}")
        print(f"彙總：{summary_report_path}")
        if args.fail_on_overflow and overflow_rows:
            return 1
        return 0
    except (OSError, ValueError, json.JSONDecodeError, sqlite3.DatabaseError) as error:
        print(f"錯誤：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
