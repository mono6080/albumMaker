import io as _io
import json
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from database import TemplatePage, Template, get_db
from services.render_service import UPLOADS_DIR, render_page

router = APIRouter(prefix="/api/templates", tags=["templates"])


@router.get("/")
def list_templates(db: Session = Depends(get_db)):
    templates = db.query(Template).order_by(Template.created_at.desc()).all()
    return [{"id": t.id, "name": t.name, "created_at": t.created_at,
             "page_count": len(t.pages)} for t in templates]


@router.post("/")
def create_template(name: str = Form(...), db: Session = Depends(get_db)):
    t = Template(name=name)
    db.add(t)
    db.commit()
    db.refresh(t)
    return {"id": t.id, "name": t.name}


@router.patch("/{template_id}")
def rename_template(template_id: int, name: str = Form(...), db: Session = Depends(get_db)):
    t = db.query(Template).filter(Template.id == template_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    t.name = name.strip()
    db.commit()
    return {"ok": True}


@router.get("/{template_id}")
def get_template(template_id: int, db: Session = Depends(get_db)):
    t = db.query(Template).filter(Template.id == template_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    return {
        "id": t.id, "name": t.name, "created_at": t.created_at,
        "pages": [
            {
                "id": p.id,
                "page_number": p.page_number,
                "background_filename": p.background_filename,
                "layout": json.loads(p.layout_json)
            }
            for p in t.pages
        ]
    }


@router.delete("/{template_id}")
def delete_template(template_id: int, db: Session = Depends(get_db)):
    t = db.query(Template).filter(Template.id == template_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    db.delete(t)
    db.commit()
    return {"ok": True}


# ── Pages ────────────────────────────────────────────────────────────────────

@router.post("/{template_id}/pages")
def add_page(template_id: int, db: Session = Depends(get_db)):
    t = db.query(Template).filter(Template.id == template_id).first()
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    next_num = max((p.page_number for p in t.pages), default=-1) + 1
    page = TemplatePage(template_id=template_id, page_number=next_num,
                        layout_json=json.dumps({
                            "canvas_width": 794, "canvas_height": 1123,
                            "photo_slots": [], "text_bubbles": [], "stickers": [],
                            "footer": None, "logo": None
                        }))
    db.add(page)
    db.commit()
    db.refresh(page)
    return {"id": page.id, "page_number": page.page_number}


@router.put("/{template_id}/pages/{page_id}/layout")
def update_page_layout(template_id: int, page_id: int,
                        layout: dict, db: Session = Depends(get_db)):
    page = db.query(TemplatePage).filter(
        TemplatePage.id == page_id,
        TemplatePage.template_id == template_id
    ).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    page.layout_json = json.dumps(layout)
    db.commit()
    return {"ok": True}


@router.post("/{template_id}/pages/{page_id}/background")
async def upload_background(template_id: int, page_id: int,
                             file: UploadFile = File(...),
                             db: Session = Depends(get_db)):
    page = db.query(TemplatePage).filter(
        TemplatePage.id == page_id,
        TemplatePage.template_id == template_id
    ).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    dest = UPLOADS_DIR / "backgrounds" / f"tmpl{template_id}_page{page_id}_{file.filename}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)

    page.background_filename = dest.name
    # Store filename in layout too for convenience
    layout = json.loads(page.layout_json)
    layout["background_filename"] = dest.name
    page.layout_json = json.dumps(layout)
    db.commit()
    return {"filename": dest.name}


@router.get("/{template_id}/pages/{page_id}/background")
def get_background(template_id: int, page_id: int, db: Session = Depends(get_db)):
    page = db.query(TemplatePage).filter(
        TemplatePage.id == page_id,
        TemplatePage.template_id == template_id
    ).first()
    if not page or not page.background_filename:
        raise HTTPException(status_code=404, detail="No background")
    path = UPLOADS_DIR / "backgrounds" / page.background_filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path)


@router.post("/{template_id}/stickers")
async def upload_sticker(template_id: int, file: UploadFile = File(...)):
    dest_dir = UPLOADS_DIR / "stickers" / f"tmpl{template_id}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / file.filename
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    return {"path": f"stickers/tmpl{template_id}/{file.filename}", "filename": file.filename}


@router.get("/{template_id}/stickers/{filename}")
def get_sticker(template_id: int, filename: str):
    path = UPLOADS_DIR / "stickers" / f"tmpl{template_id}" / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Sticker not found")
    return FileResponse(str(path))


@router.get("/{template_id}/pages/{page_id}/preview")
def preview_template_page(template_id: int, page_id: int, db: Session = Depends(get_db)):
    page = db.query(TemplatePage).filter(
        TemplatePage.id == page_id,
        TemplatePage.template_id == template_id
    ).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    layout = json.loads(page.layout_json)
    img = render_page(layout, "（姓名）", {}, page_index=page.page_number)
    buf = _io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/jpeg")


@router.delete("/{template_id}/pages/{page_id}")
def delete_page(template_id: int, page_id: int, db: Session = Depends(get_db)):
    page = db.query(TemplatePage).filter(
        TemplatePage.id == page_id,
        TemplatePage.template_id == template_id
    ).first()
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    db.delete(page)
    db.commit()
    return {"ok": True}
