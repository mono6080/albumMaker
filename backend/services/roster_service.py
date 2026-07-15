"""相容 facade；名冊 identity、學期補渲染與匯出由專責模組持有。"""

from services.roster_identity_service import (
    delete_roster_child_if_orphaned,
    link_student_to_new_child,
    link_student_to_roster_child,
    merge_roster_child_into,
    merge_roster_children,
    normalize_child_name,
    resolve_roster_child_id,
)
from services.semester_export_service import (
    build_semester_export_preview,
    load_export_periods,
    load_export_projects,
    load_output_keys_by_project,
    open_semester_export_zip_stream,
    student_pdf_key,
)
from services.semester_render_service import render_missing_semester_albums


__all__ = [
    "build_semester_export_preview",
    "delete_roster_child_if_orphaned",
    "link_student_to_new_child",
    "link_student_to_roster_child",
    "load_export_periods",
    "load_export_projects",
    "load_output_keys_by_project",
    "merge_roster_child_into",
    "merge_roster_children",
    "normalize_child_name",
    "open_semester_export_zip_stream",
    "render_missing_semester_albums",
    "resolve_roster_child_id",
    "student_pdf_key",
]
