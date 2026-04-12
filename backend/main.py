# 應用程式進入點
# 負責建立 FastAPI 實例、掛載中介層、路由與靜態檔案服務，
# 以及啟動時執行資料庫初始化與遷移

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from database import init_db
from migrations import run_migrations
from routers import templates, projects

# 前端編譯輸出目錄
FRONTEND_DIST_DIR = Path(__file__).parent.parent / "frontend" / "dist"

app = FastAPI(title="幼兒園相本製作系統")

# 允許前端開發伺服器跨域存取
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(templates.router)
app.include_router(projects.router)


@app.get("/api/health")
def health_check():
    """健康檢查端點，確認後端服務正常運行。"""
    return {"status": "ok"}


@app.on_event("startup")
def on_startup():
    """啟動時初始化資料庫結構並執行待遷移的 schema 變更。"""
    init_db()
    run_migrations()


# 掛載靜態資源（JS / CSS 編譯包）
if (FRONTEND_DIST_DIR / "assets").exists():
    app.mount(
        "/assets",
        StaticFiles(directory=str(FRONTEND_DIST_DIR / "assets")),
        name="assets"
    )


# SPA catch-all 路由 — 必須放在最後，
# 對所有非 API 路徑回傳 index.html，讓前端 Router 接管
@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    """回傳前端 SPA 的入口頁面。"""
    index_html_path = FRONTEND_DIST_DIR / "index.html"
    if index_html_path.exists():
        return FileResponse(index_html_path)
    raise HTTPException(
        status_code=404,
        detail="Frontend not built. Run build_frontend.bat"
    )
