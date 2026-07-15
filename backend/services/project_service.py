"""專案服務公開相容 facade；新程式應直接 import 各責任 owner。"""

from services.label_texts import merge_project_label_texts_into_pages
from services.output_keys import (
    build_combined_stem,
    build_content_disposition_header,
    get_project_output_prefix,
    make_safe_filename,
    student_pdf_key_for_mode,
)
from services.project_archive_service import purge_expired_archived_projects
from services.project_export_service import (
    build_zip_of_student_images,
    get_student_image_entries,
    open_all_student_images_zip_stream,
    open_all_student_pdfs_zip_stream,
)
from services.student_render_service import (
    _RENDER_PIPELINE_FILES,
    _album_render_hash,
    _clear_student_render_outputs,
    _render_pipeline_fingerprint,
    clear_student_render_outputs,
    get_template_page_layouts,
    render_and_save_student_album,
)


__all__ = [
    "_RENDER_PIPELINE_FILES",
    "_album_render_hash",
    "_clear_student_render_outputs",
    "_render_pipeline_fingerprint",
    "build_combined_stem",
    "build_content_disposition_header",
    "build_zip_of_student_images",
    "clear_student_render_outputs",
    "get_project_output_prefix",
    "get_student_image_entries",
    "get_template_page_layouts",
    "make_safe_filename",
    "merge_project_label_texts_into_pages",
    "open_all_student_images_zip_stream",
    "open_all_student_pdfs_zip_stream",
    "purge_expired_archived_projects",
    "render_and_save_student_album",
    "student_pdf_key_for_mode",
]
