# 專案業務邏輯服務模組
# 集中管理與「渲染學生相冊」、「合併氣泡文字」、「檔名處理」、
# 「HTTP 下載標頭」相關的業務邏輯，使路由層保持薄且清晰

import io
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import quote

from database import Project, Student
from services.render_service import (
    UPLOADS_DIR, render_album, save_album_pdf, save_album_images
)


# ── 檔名與目錄工具 ─────────────────────────────────────────────────────────────

def make_safe_filename(name: str) -> str:
    """將名稱中的 Windows / Linux 非法字元替換為底線，確保可用作檔名。"""
    return re.sub(r'[\\/:*?"<>|]', '_', name).strip() or "unnamed"


def get_project_output_dir(project_id: int) -> Path:
    """取得專案 PDF 輸出目錄，目錄不存在時自動建立。"""
    output_dir = UPLOADS_DIR / "output" / f"proj{project_id}"
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


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


# ── 氣泡文字合併 ───────────────────────────────────────────────────────────────

def merge_project_bubble_texts_into_pages(
    student_pages_data: list,
    project_bubble_texts: dict
) -> list:
    """
    將專案層級氣泡文字合併入學生頁面資料，作為學生未自訂時的預設值。

    優先順序（高到低）：
      學生個人氣泡文字 > 專案層級氣泡文字 > 模板預設文字（由 render_page 處理）

    回傳新的 pages_data 列表，不修改原始物件。
    """
    merged_pages = []
    for page_data in student_pages_data:
        page_index_key = str(page_data.get("page_index", 0))
        project_page_bubble_texts = project_bubble_texts.get(page_index_key, {})
        if project_page_bubble_texts:
            # 學生的設定優先；專案設定補足尚未覆寫的氣泡
            merged_bubble_texts = {**project_page_bubble_texts, **page_data.get("bubble_texts", {})}
            page_data = {**page_data, "bubble_texts": merged_bubble_texts}
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
    db
) -> dict:
    """
    渲染單一學生的相冊頁面並儲存為 PDF 與頁面圖片。

    流程：
      1. 讀取模板佈局
      2. 將專案氣泡文字合併入學生頁面資料
      3. 呼叫渲染引擎產生圖片
      4. 儲存列印用 PDF、螢幕用 PDF、單頁圖片
      5. 更新學生的輸出路徑記錄

    回傳：包含 pdf 路徑與頁數的 dict。
    """
    page_layouts = get_template_page_layouts(project)
    if not page_layouts:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Template has no pages")

    project_bubble_texts = json.loads(project.bubble_texts_json or "{}")
    student_pages_data = merge_project_bubble_texts_into_pages(
        json.loads(student.pages_data_json),
        project_bubble_texts
    )

    rendered_images = render_album(page_layouts, student.name, student_pages_data)

    output_dir = get_project_output_dir(project_id)
    combined_stem = build_combined_stem(project.name, student.name)
    print_pdf_path = output_dir / f"{combined_stem}.pdf"
    screen_pdf_path = output_dir / f"{combined_stem}_screen.pdf"

    save_album_pdf(rendered_images, print_pdf_path, mode="print")
    save_album_pdf(rendered_images, screen_pdf_path, mode="screen")
    save_album_images(rendered_images, output_dir / combined_stem, combined_stem)

    student.output_filename = str(print_pdf_path)
    db.commit()

    return {"pdf": str(print_pdf_path), "pages": len(rendered_images)}


# ── ZIP 封裝 ───────────────────────────────────────────────────────────────────

def build_zip_of_all_student_pdfs(project: Project, output_mode: str) -> bytes:
    """
    將專案中所有已渲染學生的 PDF 打包成 ZIP，回傳 bytes。

    output_mode：'print'（列印畫質）或 'screen'（螢幕顯示畫質）
    """
    output_buffer = io.BytesIO()
    with zipfile.ZipFile(output_buffer, "w", zipfile.ZIP_DEFLATED) as zip_archive:
        for student in project.students:
            if not student.output_filename:
                continue
            base_path = Path(student.output_filename)
            pdf_path = (
                base_path.parent / f"{base_path.stem}_screen.pdf"
                if output_mode == "screen"
                else base_path
            )
            if not pdf_path.exists():
                continue
            combined_stem = build_combined_stem(project.name, student.name)
            suffix = "_screen" if output_mode == "screen" else ""
            zip_archive.write(pdf_path, f"{combined_stem}{suffix}.pdf")
    output_buffer.seek(0)
    return output_buffer.read()
