from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from database import init_db
from routers import templates, projects

FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"

app = FastAPI(title="幼兒園相本製作系統")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(templates.router)
app.include_router(projects.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.on_event("startup")
def startup():
    init_db()
    _migrate_db()


def _migrate_db():
    """Add columns introduced after initial schema without dropping existing data."""
    from sqlalchemy import text
    from database import engine
    with engine.connect() as conn:
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info(projects)"))}
        if "bubble_texts_json" not in existing:
            conn.execute(text("ALTER TABLE projects ADD COLUMN bubble_texts_json TEXT NOT NULL DEFAULT '{}'"))
            conn.commit()


# Serve static assets (JS/CSS bundles)
if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")


# SPA catch-all — must be LAST; returns index.html for all non-API paths
@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index)
    raise HTTPException(status_code=404, detail="Frontend not built. Run build_frontend.bat")
