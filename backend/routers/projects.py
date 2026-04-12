import json
import re
import shutil
import zipfile
import io
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from database import Project, Student, Template, TemplatePage, get_db
from services.render_service import (
    BACKEND_DIR, UPLOADS_DIR, render_album, save_album_pdf, save_album_images
)

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("/")
def list_projects(db: Session = Depends(get_db)):
    projects = db.query(Project).order_by(Project.created_at.desc()).all()
    return [{"id": p.id, "name": p.name, "template_id": p.template_id,
             "created_at": p.created_at, "student_count": len(p.students)} for p in projects]


@router.post("/")
def create_project(name: str = Form(...), template_id: int = Form(...),
                   db: Session = Depends(get_db)):
    t = db.query(Template).filter(Template.id == template_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    p = Project(name=name, template_id=template_id)
    db.add(p)
    db.commit()
    db.refresh(p)
    return {"id": p.id, "name": p.name}


@router.get("/{project_id}")
def get_project(project_id: int, db: Session = Depends(get_db)):
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "id": p.id, "name": p.name, "template_id": p.template_id, "created_at": p.created_at,
        "bubble_texts": json.loads(p.bubble_texts_json or "{}"),
        "students": [
            {"id": s.id, "name": s.name, "order_index": s.order_index,
             "pages_data": json.loads(s.pages_data_json),
             "output_filename": s.output_filename}
            for s in p.students
        ]
    }


@router.patch("/{project_id}")
def rename_project(project_id: int, name: str = Form(...), db: Session = Depends(get_db)):
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    p.name = name.strip()
    db.commit()
    return {"ok": True}


@router.delete("/{project_id}")
def delete_project(project_id: int, db: Session = Depends(get_db)):
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    db.delete(p)
    db.commit()
    return {"ok": True}


# ── Students ──────────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/batch")
def batch_add_students(project_id: int, names: list[str], db: Session = Depends(get_db)):
    """Add multiple students at once. Provide list of names. Skips blanks and duplicates."""
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    # Existing names in this project
    existing = {s.name for s in p.students}
    created = []
    skipped = []
    seen_in_batch = set()
    next_order = max((s.order_index for s in p.students), default=-1) + 1
    for name in names:
        name = name.strip()
        if not name:
            continue
        if name in existing or name in seen_in_batch:
            skipped.append(name)
            continue
        seen_in_batch.add(name)
        s = Student(project_id=project_id, name=name, order_index=next_order, pages_data_json="[]")
        db.add(s)
        created.append(name)
        next_order += 1
    db.commit()
    return {"created": created, "skipped": skipped}


@router.put("/{project_id}/students/{student_id}")
def update_student(project_id: int, student_id: int,
                   name: Optional[str] = Form(None),
                   db: Session = Depends(get_db)):
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Student not found")
    if name:
        s.name = name
    db.commit()
    return {"ok": True}


@router.delete("/{project_id}/students/{student_id}")
def delete_student(project_id: int, student_id: int, db: Session = Depends(get_db)):
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Student not found")
    db.delete(s)
    db.commit()
    return {"ok": True}


# ── Photo upload ──────────────────────────────────────────────────────────────

@router.post("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}")
async def upload_photo(project_id: int, student_id: int, page_index: int, slot_id: int,
                       file: UploadFile = File(...), db: Session = Depends(get_db)):
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Student not found")

    dest_dir = UPLOADS_DIR / "photos" / f"proj{project_id}" / f"student{student_id}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = f"p{page_index}_slot{slot_id}_{file.filename}"
    dest = dest_dir / filename
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    pages_data = json.loads(s.pages_data_json)
    # Ensure page entry exists
    while len(pages_data) <= page_index:
        pages_data.append({"page_index": len(pages_data), "photos": {}, "bubble_texts": {}})
    pages_data[page_index]["photos"][str(slot_id)] = {
        "path": str(dest), "scale": 1.0, "offset_x": 0.0, "offset_y": 0.0
    }
    s.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"filename": filename, "path": str(dest)}


@router.get("/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}")
def get_photo(project_id: int, student_id: int, page_index: int, slot_id: int,
              db: Session = Depends(get_db)):
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Student not found")
    pages_data = json.loads(s.pages_data_json)
    if page_index >= len(pages_data):
        raise HTTPException(status_code=404, detail="Page not found")
    photo_val = pages_data[page_index].get("photos", {}).get(str(slot_id))
    if not photo_val:
        raise HTTPException(status_code=404, detail="Photo not found")
    path_str = photo_val if isinstance(photo_val, str) else photo_val.get("path", "")
    if not path_str:
        raise HTTPException(status_code=404, detail="Photo not found")
    p = Path(path_str)
    if not p.is_absolute():
        from services.render_service import BACKEND_DIR
        candidate = BACKEND_DIR.parent / path_str
        if candidate.exists():
            p = candidate
        else:
            p = BACKEND_DIR / path_str
    if not p.exists():
        raise HTTPException(status_code=404, detail="Photo not found")
    return FileResponse(str(p))


# ── Photo mapping (reorder / delete without re-upload) ───────────────────────

@router.put("/{project_id}/students/{student_id}/photos/mapping")
def update_photo_mapping(project_id: int, student_id: int, payload: dict,
                         db: Session = Depends(get_db)):
    """
    Directly update the slot→path mapping in pages_data_json.
    payload: {"pages": {"0": {"1": "/server/path", "2": null}, ...}}
    null value clears the slot.
    """
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Student not found")
    pages_data = json.loads(s.pages_data_json)
    for page_idx_str, slots in payload.get("pages", {}).items():
        page_idx = int(page_idx_str)
        while len(pages_data) <= page_idx:
            pages_data.append({"page_index": len(pages_data), "photos": {}, "bubble_texts": {}})
        for slot_id_str, path in slots.items():
            if path is None:
                pages_data[page_idx]["photos"].pop(slot_id_str, None)
            else:
                pages_data[page_idx]["photos"][slot_id_str] = path
    s.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True}


# ── Project-level bubble texts ────────────────────────────────────────────────

@router.get("/{project_id}/bubble_texts")
def get_project_bubble_texts(project_id: int, db: Session = Depends(get_db)):
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    return json.loads(p.bubble_texts_json or "{}")


@router.put("/{project_id}/bubble_texts")
def update_project_bubble_texts(project_id: int, payload: dict, db: Session = Depends(get_db)):
    """payload: {"<page_index>": {"<bubble_id>": "text", ...}, ...}"""
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    p.bubble_texts_json = json.dumps(payload)
    db.commit()
    return {"ok": True}


@router.get("/{project_id}/preview/{page_index}")
def preview_project_page(project_id: int, page_index: int, db: Session = Depends(get_db)):
    """Render a page using project-level bubble texts and a placeholder name."""
    import io as _io
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")

    layouts = _get_template_page_layouts(p)
    if page_index >= len(layouts):
        raise HTTPException(status_code=404, detail="Page index out of range")

    project_bt = json.loads(p.bubble_texts_json or "{}")
    page_data = {"bubble_texts": project_bt.get(str(page_index), {})}

    from services.render_service import render_page
    img = render_page(layouts[page_index], "（姓名）", page_data, page_index=page_index)

    buf = _io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=85)
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/jpeg")


# ── Per-student bubble texts ───────────────────────────────────────────────────

@router.put("/{project_id}/students/{student_id}/pages/{page_index}/texts")
def update_bubble_texts(project_id: int, student_id: int, page_index: int,
                        texts: dict, db: Session = Depends(get_db)):
    """texts: { "1": "bubble text...", "2": "..." }"""
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Student not found")
    pages_data = json.loads(s.pages_data_json)
    while len(pages_data) <= page_index:
        pages_data.append({"page_index": len(pages_data), "photos": {}, "bubble_texts": {}})
    pages_data[page_index]["bubble_texts"] = texts
    s.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True}


# ── Batch text fill ───────────────────────────────────────────────────────────

@router.put("/{project_id}/batch/texts")
def batch_update_texts(project_id: int, payload: dict, db: Session = Depends(get_db)):
    """
    payload: {
      "students": {
        "<student_id>": {
          "<page_index>": { "<bubble_id>": "text", ... },
          ...
        },
        ...
      }
    }
    """
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")

    students_payload = payload.get("students", {})
    for s in p.students:
        sid = str(s.id)
        if sid not in students_payload:
            continue
        pages_data = json.loads(s.pages_data_json)
        for page_idx_str, texts in students_payload[sid].items():
            page_idx = int(page_idx_str)
            while len(pages_data) <= page_idx:
                pages_data.append({"page_index": len(pages_data), "photos": {}, "bubble_texts": {}})
            pages_data[page_idx]["bubble_texts"] = texts
        s.pages_data_json = json.dumps(pages_data)
    db.commit()
    return {"ok": True}


# ── Render ────────────────────────────────────────────────────────────────────

def _get_template_page_layouts(project: Project) -> list[dict]:
    layouts = []
    for page in project.template.pages:
        layout = json.loads(page.layout_json)
        layout["background_filename"] = page.background_filename
        layouts.append(layout)
    return layouts


def _safe_filename(name: str) -> str:
    """Strip characters illegal in file/dir names on Windows and Linux."""
    return re.sub(r'[\\/:*?"<>|]', '_', name).strip() or "unnamed"


def _merge_project_bubble_texts(pages_data: list, project_bt: dict) -> list:
    """
    Return pages_data with project-level bubble_texts merged in as fallback.
    Priority: student bubble_texts > project bubble_texts > template defaults (handled in render_page).
    """
    result = []
    for pd in pages_data:
        page_idx = str(pd.get("page_index", 0))
        proj_page_bt = project_bt.get(page_idx, {})
        if proj_page_bt:
            # Student's own entries win; project fills in anything missing
            merged = {**proj_page_bt, **pd.get("bubble_texts", {})}
            pd = {**pd, "bubble_texts": merged}
        result.append(pd)
    # For pages not yet in pages_data, project_bt entries are handled by render_page fallback
    return result


@router.post("/{project_id}/students/{student_id}/render")
def render_student(project_id: int, student_id: int, db: Session = Depends(get_db)):
    """Render one student's album to PDF + images."""
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Student not found")

    layouts = _get_template_page_layouts(p)
    if not layouts:
        raise HTTPException(status_code=400, detail="Template has no pages")

    project_bt = json.loads(p.bubble_texts_json or "{}")
    pages_data = _merge_project_bubble_texts(json.loads(s.pages_data_json), project_bt)
    images = render_album(layouts, s.name, pages_data)

    safe_proj = _safe_filename(p.name)
    safe_student = _safe_filename(s.name)
    combined = f"{safe_proj}-{safe_student}"
    out_dir = UPLOADS_DIR / "output" / f"proj{project_id}"
    pdf_path = out_dir / f"{combined}.pdf"
    screen_path = out_dir / f"{combined}_screen.pdf"
    save_album_pdf(images, pdf_path, mode="print")
    save_album_pdf(images, screen_path, mode="screen")
    save_album_images(images, out_dir / combined, combined)

    s.output_filename = str(pdf_path)
    db.commit()
    return {"pdf": str(pdf_path), "pages": len(images)}


@router.post("/{project_id}/render/all")
def render_all(project_id: int, db: Session = Depends(get_db)):
    """Batch render all students in a project."""
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")

    layouts = _get_template_page_layouts(p)
    if not layouts:
        raise HTTPException(status_code=400, detail="Template has no pages")

    project_bt = json.loads(p.bubble_texts_json or "{}")
    results = []
    errors = []
    out_dir = UPLOADS_DIR / "output" / f"proj{project_id}"
    for s in p.students:
        try:
            pages_data = _merge_project_bubble_texts(json.loads(s.pages_data_json), project_bt)
            images = render_album(layouts, s.name, pages_data)
            safe_proj = _safe_filename(p.name)
            safe_student = _safe_filename(s.name)
            combined = f"{safe_proj}-{safe_student}"
            pdf_path = out_dir / f"{combined}.pdf"
            screen_path = out_dir / f"{combined}_screen.pdf"
            save_album_pdf(images, pdf_path, mode="print")
            save_album_pdf(images, screen_path, mode="screen")
            save_album_images(images, out_dir / combined, combined)
            s.output_filename = str(pdf_path)
            results.append({"student": s.name, "pdf": str(pdf_path)})
        except Exception as e:
            errors.append({"student": s.name, "error": str(e)})
    db.commit()
    return {"rendered": results, "errors": errors}


@router.get("/{project_id}/students/{student_id}/pdf")
def download_pdf(project_id: int, student_id: int,
                 mode: str = Query("print", regex="^(print|screen)$"),
                 db: Session = Depends(get_db)):
    p = db.query(Project).filter(Project.id == project_id).first()
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s or not s.output_filename:
        raise HTTPException(status_code=404, detail="PDF not generated yet")
    base = Path(s.output_filename)
    path = (base.parent / f"{base.stem}_screen.pdf") if mode == "screen" else base
    if not path.exists():
        raise HTTPException(status_code=404, detail="PDF file missing — please render first")
    safe_proj = _safe_filename(p.name) if p else ""
    safe_student = _safe_filename(s.name)
    combined = f"{safe_proj}-{safe_student}" if safe_proj else safe_student
    suffix = "_screen" if mode == "screen" else ""
    from urllib.parse import quote
    dl_name = f"{combined}{suffix}.pdf"
    encoded = quote(dl_name, safe="")
    ascii_fallback = re.sub(r'[^\x00-\x7F]', '_', combined) + suffix + ".pdf"
    headers = {"Content-Disposition": f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}"}
    return FileResponse(path, media_type="application/pdf", headers=headers)


@router.get("/{project_id}/download/all")
def download_all_zip(project_id: int,
                     mode: str = Query("print", regex="^(print|screen)$"),
                     db: Session = Depends(get_db)):
    """Download all generated PDFs as a zip."""
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for s in p.students:
            if not s.output_filename:
                continue
            base = Path(s.output_filename)
            pdf_file = (base.parent / f"{base.stem}_screen.pdf") if mode == "screen" else base
            if pdf_file.exists():
                safe_proj = _safe_filename(p.name)
                safe_student = _safe_filename(s.name)
                suffix = "_screen" if mode == "screen" else ""
                zf.write(pdf_file, f"{safe_proj}-{safe_student}{suffix}.pdf")
    buf.seek(0)
    from urllib.parse import quote
    encoded_name = quote(f"{p.name}.zip", safe="")
    # Use ASCII-only fallback; RFC 5987 filename* carries the full name
    ascii_fallback = re.sub(r'[^\x00-\x7F]', '_', _safe_filename(p.name))
    disposition = f"attachment; filename=\"{ascii_fallback}.zip\"; filename*=UTF-8''{encoded_name}"
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": disposition})


@router.get("/{project_id}/students/{student_id}/preview/{page_index}")
def preview_page(project_id: int, student_id: int, page_index: int, db: Session = Depends(get_db)):
    """Return a JPEG preview of one page."""
    import io as _io
    p = db.query(Project).filter(Project.id == project_id).first()
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    s = db.query(Student).filter(Student.id == student_id, Student.project_id == project_id).first()
    if not s:
        raise HTTPException(status_code=404, detail="Student not found")

    layouts = _get_template_page_layouts(p)
    if page_index >= len(layouts):
        raise HTTPException(status_code=404, detail="Page index out of range")

    project_bt = json.loads(p.bubble_texts_json or "{}")
    pages_data = _merge_project_bubble_texts(json.loads(s.pages_data_json), project_bt)
    data_map = {pd["page_index"]: pd for pd in pages_data}
    page_data = data_map.get(page_index, {})

    from services.render_service import render_page
    img = render_page(layouts[page_index], s.name, page_data, page_index=page_index)

    buf = _io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=85)
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/jpeg")
