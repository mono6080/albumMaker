# 老師進度總覽服務
# 主管/管理者檢視範圍內每位老師的各期專案完成度（照片填格、空白文字格），
# 以及對應的 Excel 匯出（摘要 + 明細）

import io
import json

from sqlalchemy.orm import Session

from database import User
from services.label_texts import get_label_entry_text
from services.project_service import (
    get_template_page_layouts,
    merge_project_label_texts_into_pages,
)
from services.roster_service import load_export_periods, load_export_projects


def _summarize_student_progress(
    pages_data: list, page_layouts: list[dict], project_label_texts: dict
) -> tuple[int, int, int]:
    """單一學生的（照片已填格數, 照片總格數, 空白輸出文字格數）；略過 skip 頁。

    空白輸出＝依「學生覆寫 > 專案覆寫 > 模板預設」合併後渲染會是空白的文字格
    （含刻意設為空白），供主管抽查用。
    """
    # 「有效文字」走與渲染完全相同的合併機器（學生>專案，含 legacy 覆寫清理）：
    # 自己重推優先序會與渲染分歧（例如 legacy 學生覆寫＋專案刻意空白時判錯）
    merged_pages = merge_project_label_texts_into_pages(pages_data, project_label_texts, page_layouts)
    merged_by_index = {
        page_data.get("page_index"): page_data
        for page_data in merged_pages
        if isinstance(page_data, dict)
    }

    photo_filled_count = 0
    photo_total_count = 0
    blank_text_count = 0
    for page_index, layout in enumerate(page_layouts):
        page_data = merged_by_index.get(page_index, {})
        if page_data.get("skip"):
            continue
        page_photos = page_data.get("photos") or {}
        for photo_slot in layout.get("photo_slots", []):
            photo_total_count += 1
            if page_photos.get(str(photo_slot.get("id"))):
                photo_filled_count += 1
        merged_label_texts = page_data.get("label_texts") or {}
        for text_label in layout.get("text_labels", []):
            label_id = str(text_label.get("id"))
            effective_text = get_label_entry_text(merged_label_texts.get(label_id))
            if effective_text is None:
                # 未覆寫時 fallback 模板預設（與 render_text_label 相同）
                effective_text = text_label.get("text")
            if not str(effective_text or "").strip():
                blank_text_count += 1
    return photo_filled_count, photo_total_count, blank_text_count


def build_teacher_progress_overview(
    db: Session, period_ids: list[int], owner_user_ids: list[int] | None = None
) -> dict:
    """老師進度總覽：範圍內每位可帶班使用者（含尚未建專案者）的各期專案與完成度。

    owner_user_ids 給定時只列這些使用者（主管檢視管轄老師）。
    尚未建立任何專案的老師以空 projects 呈現——這正是主管追進度要看的對象。
    """
    periods = load_export_periods(db, period_ids)
    projects = load_export_projects(db, period_ids, owner_user_ids)

    listed_users_query = db.query(User).filter(User.role.in_(("teacher", "supervisor")))
    if owner_user_ids is not None:
        listed_users_query = listed_users_query.filter(User.id.in_(owner_user_ids))
    teacher_groups: dict = {}
    for listed_user in listed_users_query.all():
        teacher_groups[listed_user.id] = {
            "user_id": listed_user.id,
            "display_name": listed_user.display_name,
            "projects": [],
        }

    # 版型逐模板讀一次；owner 是 admin（過繼）或未指定時補一組群組
    layouts_by_template: dict[int, list[dict]] = {}
    for project in projects:
        if project.template_id not in layouts_by_template:
            layouts_by_template[project.template_id] = get_template_page_layouts(project)
        page_layouts = layouts_by_template[project.template_id]
        try:
            project_label_texts = json.loads(project.label_texts_json or "{}")
        except ValueError:
            project_label_texts = {}

        owner_display_name = project.owner.display_name if project.owner else "（未指定老師）"
        group_key = project.owner_id if project.owner_id is not None else f"name:{owner_display_name}"
        teacher_group = teacher_groups.setdefault(group_key, {
            "user_id": project.owner_id,
            "display_name": owner_display_name,
            "projects": [],
        })

        students_payload = []
        project_photo_filled = 0
        project_photo_total = 0
        project_blank_text_count = 0
        for student in project.students:
            try:
                pages_data = json.loads(student.pages_data_json or "[]")
            except ValueError:
                pages_data = []
            photo_filled, photo_total, blank_text_count = _summarize_student_progress(
                pages_data if isinstance(pages_data, list) else [],
                page_layouts,
                project_label_texts,
            )
            project_photo_filled += photo_filled
            project_photo_total += photo_total
            project_blank_text_count += blank_text_count
            students_payload.append({
                "student_id": student.id,
                "student_name": student.name,
                "photo_filled": photo_filled,
                "photo_total": photo_total,
                "blank_text_count": blank_text_count,
            })

        teacher_group["projects"].append({
            "project_id": project.id,
            "project_name": project.name,
            "period_id": project.template_period_id,
            "student_count": len(students_payload),
            "photo_filled": project_photo_filled,
            "photo_total": project_photo_total,
            "blank_text_count": project_blank_text_count,
            # 全班完成時間：非 NULL 代表老師已按下「全班完成」
            "completed_at": project.completed_at.isoformat() if project.completed_at else None,
            "students": students_payload,
        })

    return {
        "periods": [
            {"id": period.id, "name": period.name, "department": period.department}
            for period in periods
        ],
        "teachers": sorted(teacher_groups.values(), key=lambda group: group["display_name"]),
    }


def build_teacher_overview_workbook(
    db: Session, period_ids: list[int], owner_user_ids: list[int] | None = None
) -> bytes:
    """產出老師進度 Excel：摘要（每師一列，含完成度）與明細（每生一列）兩張工作表。"""
    from openpyxl import Workbook
    from openpyxl.styles import Font

    overview = build_teacher_progress_overview(db, period_ids, owner_user_ids)
    period_names = {period["id"]: period["name"] for period in overview["periods"]}

    workbook = Workbook()
    header_font = Font(bold=True)

    summary_sheet = workbook.active
    summary_sheet.title = "摘要"
    summary_sheet.append(["老師", "專案數", "已完成專案", "學生數", "照片已填/總格數", "空白文字格"])
    for teacher_group in overview["teachers"]:
        teacher_projects = teacher_group["projects"]
        photo_filled = sum(project["photo_filled"] for project in teacher_projects)
        photo_total = sum(project["photo_total"] for project in teacher_projects)
        summary_sheet.append([
            teacher_group["display_name"],
            len(teacher_projects),
            sum(1 for project in teacher_projects if project["completed_at"]),
            sum(project["student_count"] for project in teacher_projects),
            f"{photo_filled}/{photo_total}" if photo_total else ("—" if teacher_projects else "尚未開始"),
            sum(project["blank_text_count"] for project in teacher_projects),
        ])

    detail_sheet = workbook.create_sheet("明細")
    detail_sheet.append(["老師", "期別", "專案（班級）", "學生", "照片已填", "照片總格", "空白文字格"])
    for teacher_group in overview["teachers"]:
        for project in teacher_group["projects"]:
            for student in project["students"]:
                detail_sheet.append([
                    teacher_group["display_name"],
                    period_names.get(project["period_id"], "?"),
                    project["project_name"],
                    student["student_name"],
                    student["photo_filled"],
                    student["photo_total"],
                    student["blank_text_count"],
                ])

    for sheet in (summary_sheet, detail_sheet):
        for cell in sheet[1]:
            cell.font = header_font
        # 依內容粗略調整欄寬，避免中文擠成一團
        for column_cells in sheet.columns:
            max_length = max(len(str(cell.value or "")) for cell in column_cells)
            sheet.column_dimensions[column_cells[0].column_letter].width = min(max_length * 2 + 4, 40)

    output_buffer = io.BytesIO()
    workbook.save(output_buffer)
    output_buffer.seek(0)
    return output_buffer.read()
