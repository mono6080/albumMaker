# 應用程式進入點
# 負責建立 FastAPI 實例、掛載中介層、路由與靜態檔案服務，
# 以及啟動時執行資料庫初始化與遷移

import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware

from database import init_db
from migrations import run_migrations
from routers import templates, projects, auth, users

# 速率限制器（依客戶端 IP 計算）
limiter = Limiter(key_func=get_remote_address)

# 前端編譯輸出目錄
FRONTEND_DIST_DIR = Path(__file__).parent.parent / "frontend" / "dist"

app = FastAPI(title="幼兒園相本製作系統")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """為所有回應加入基本安全 HTTP Headers，防止 Clickjacking、MIME sniffing 等攻擊。"""
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response


app.add_middleware(SecurityHeadersMiddleware)

# 允許前端開發伺服器跨域存取（正式網域由環境變數 ALLOWED_ORIGINS 設定，逗號分隔）
_raw_origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
_allowed_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=True,  # Cookie 認證需要
)

app.include_router(auth.router)
app.include_router(users.router)
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
