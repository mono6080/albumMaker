# 專案業務邏輯服務模組
# 集中管理與「渲染學生相冊」、「合併氣泡文字」、「檔名處理」、
# 「HTTP 下載標頭」相關的業務邏輯，使路由層保持薄且清晰

import io
import json
import re
import zipfile
from urllib.parse import quote

from database import Project, Student
from services.render_service import render_album, save_album_pdf, save_album_images
from services.storage import get_storage


# ── 檔名與目錄工具 ─────────────────────────────────────────────────────────────

def make_safe_filename(name: str) -> str:
    """將名稱中的 Windows / Linux 非法字元替換為底線，確保可用作檔名。"""
    return re.sub(r'[\\/:*?"<>|]', '_', name).strip() or "unnamed"


def get_project_output_prefix(project_id: int) -> str:
    """回傳專案輸出檔案的 storage key 前綴。"""
    return f"projects/proj{project_id}/output"


def build_combined_stem(project_name: str, student_name: str) -> str:
    """組合專案名稱與學生名稱為安全的檔名主體，格式為「專案名-學生名」。"""
    safe_project = make_safe_filename(project_name)
    safe_student = make_safe_filename(student_name)
    return f"{safe_project}-{safe_student}"


# ── HTTP 下載標頭工具 ──────────────────────────────────────────────────────────

def build_content_disposition_header(filename: str) -> str:
    """
    建立符合 RFC 5987 的 Content-Disposition 下載標頭。
    同時提供 ASCII 備用檔名（非 ASCII 字元替換為底線）與 UTF-8 百分比編碼版本，
    確保各瀏覽器均能正確顯示中文檔名。
    """
    encoded_filename = quote(filename, safe="")
    ascii_fallback = re.sub(r'[^\x00-\x7F]', '_', filename)
    return f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded_filename}'


# ── 對印文字合併 ───────────────────────────────────────────────────────────────

def merge_project_label_texts_into_pages(
    student_pages_data: list,
    project_label_texts: dict
) -> list:
    """
    將專案層級對印文字合併入學生頁面資料，作為學生未自訂時的預設值。

    優先順序（高到低）：
      學生個人對印文字 > 專案層級對印文字 > 模板預設文字（由 render_page 處理）

    回傳新的 pages_data 列表，不修改原始物件。
    """
    merged_pages = []
    for page_data in student_pages_data:
        page_index_key = str(page_data.get("page_index", 0))
        project_page_label_texts = project_label_texts.get(page_index_key, {})
        if project_page_label_texts:
            # 學生的設定優先；專案設定補足尚未覆寫的對印文字
            merged_label_texts = {**project_page_label_texts, **page_data.get("label_texts", {})}
            page_data = {**page_data, "label_texts": merged_label_texts}
        merged_pages.append(page_data)
    return merged_pages


# ── 模板頁面佈局讀取 ───────────────────────────────────────────────────────────

def get_template_page_layouts(project: Project) -> list[dict]:
    """
    從關聯的模板頁面中讀取所有佈局設定，
    並將背景圖檔名注入佈局 dict（渲染時需要）。
    """
    page_layouts = []
    for template_page in project.template.pages:
        layout = json.loads(template_page.layout_json)
        layout["background_filename"] = template_page.background_filename
        page_layouts.append(layout)
    return page_layouts


# ── 渲染與儲存 ─────────────────────────────────────────────────────────────────

def render_and_save_student_album(
    project: Project,
    student: Student,
    project_id: int,
    db,
    page_layouts: list[dict] | None = None,
) -> dict:
    """
    渲染單一學生的相冊頁面並儲存為 PDF 與頁面圖片。

    流程：
      1. 讀取模板佈局（可由外部傳入，批次渲染時共用避免重複查詢）
      2. 將專案對印文字合併入學生頁面資料
      3. 呼叫渲染引擎產生圖片
      4. 儲存列印用 PDF、螢幕用 PDF、單頁圖片
      5. 更新學生的輸出路徑記錄

    回傳：包含 pdf 路徑與頁數的 dict。
    """
    if page_layouts is None:
        page_layouts = get_template_page_layouts(project)
    if not page_layouts:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="模板尚未建立任何頁面")

    project_label_texts = json.loads(project.label_texts_json or "{}")
    student_pages_data = merge_project_label_texts_into_pages(
        json.loads(student.pages_data_json),
        project_label_texts
    )

    rendered_images = render_album(page_layouts, student.name, student_pages_data)

    combined_stem = build_combined_stem(project.name, student.name)
    output_prefix = get_project_output_prefix(project_id)
    print_key = f"{output_prefix}/{combined_stem}.pdf"
    screen_key = f"{output_prefix}/{combined_stem}_screen.pdf"

    storage = get_storage()
    # 清除該學生舊的輸出（PDF + 頁面圖），避免無限累積
    storage.delete_prefix(f"{output_prefix}/{combined_stem}")
    storage.put(print_key, save_album_pdf(rendered_images, mode="print"))
    storage.put(screen_key, save_album_pdf(rendered_images, mode="screen"))
    for filename, img_bytes in save_album_images(rendered_images, combined_stem).items():
        storage.put(f"{output_prefix}/{combined_stem}/{filename}", img_bytes)

    student.output_filename = print_key
    db.commit()

    return {"pdf": print_key, "pages": len(rendered_images)}


# ── ZIP 封裝 ───────────────────────────────────────────────────────────────────

def build_zip_of_all_student_pdfs(project: Project, output_mode: str) -> bytes:
    """
    將專案中所有已渲染學生的 PDF 打包成 ZIP，回傳 bytes。

    output_mode：'print'（列印畫質）或 'screen'（螢幕顯示畫質）
    """
    storage = get_storage()
    output_buffer = io.BytesIO()
    with zipfile.ZipFile(output_buffer, "w", zipfile.ZIP_DEFLATED) as zip_archive:
        for student in project.students:
            if not student.output_filename:
                continue
            # output_filename 現為 key，如 "projects/proj1/output/stem.pdf"
            base_key = student.output_filename
            pdf_key = (
                base_key[:-4] + "_screen.pdf"
                if output_mode == "screen"
                else base_key
            )
            if not storage.exists(pdf_key):
                continue
            combined_stem = build_combined_stem(project.name, student.name)
            suffix = "_screen" if output_mode == "screen" else ""
            zip_archive.writestr(f"{combined_stem}{suffix}.pdf", storage.get_bytes(pdf_key))
    output_buffer.seek(0)
    return output_buffer.read()
