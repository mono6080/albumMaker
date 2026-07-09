# 應用程式進入點
# 負責建立 FastAPI 實例、掛載中介層、路由與靜態檔案服務，
# 以及啟動時執行資料庫初始化與遷移

import logging
import os
import time

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
from routers import templates, projects, auth, users, roster

logger = logging.getLogger("album_maker.requests")


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return max(0.0, float(value))
    except ValueError:
        logger.warning("invalid_env_float name=%s value=%r default=%.3f", name, value, default)
        return default


# 速率限制器（依客戶端 IP 計算）
limiter = Limiter(key_func=get_remote_address)

# 前端編譯輸出目錄
FRONTEND_DIST_DIR = Path(__file__).parent.parent / "frontend" / "dist"
FRONTEND_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
FRONTEND_APP_CACHE_CONTROL = "no-cache, no-store, max-age=0, must-revalidate"
SLOW_REQUEST_LOG_SECONDS = _env_float("SLOW_REQUEST_LOG_SECONDS", 1.0)


def apply_frontend_cache_headers(response, path: str) -> None:
    """Set cache policy for frontend files without touching API responses."""
    if path.startswith("/api/"):
        return

    if path.startswith("/assets/"):
        response.headers["Cache-Control"] = FRONTEND_ASSET_CACHE_CONTROL
        return

    # SPA routes, index.html, service workers, Workbox chunks, manifest, and
    # other root-level PWA files must be revalidated after every deploy.
    response.headers["Cache-Control"] = FRONTEND_APP_CACHE_CONTROL
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    if path == "/sw.js":
        response.headers["Service-Worker-Allowed"] = "/"


app = FastAPI(title="幼兒園相本製作系統")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """為所有回應加入基本安全 HTTP Headers，防止 Clickjacking、MIME sniffing 等攻擊。"""
    async def dispatch(self, request: Request, call_next):
        started_at = time.monotonic()
        response = await call_next(request)
        elapsed = time.monotonic() - started_at
        response.headers["X-Response-Time"] = f"{elapsed:.3f}"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        apply_frontend_cache_headers(response, request.url.path)
        if elapsed >= SLOW_REQUEST_LOG_SECONDS:
            forwarded_for = request.headers.get("x-forwarded-for")
            client_ip = (
                forwarded_for.split(",", 1)[0].strip()
                if forwarded_for
                else request.client.host if request.client else "-"
            )
            logger.warning(
                "slow_request method=%s path=%s status=%s duration=%.3fs client=%s",
                request.method,
                request.url.path,
                response.status_code,
                elapsed,
                client_ip,
            )
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
app.include_router(roster.router)


@app.get("/api/health")
def health_check():
    """健康檢查端點，確認後端服務正常運行。"""
    return {"status": "ok"}


@app.on_event("startup")
def on_startup():
    """啟動時初始化資料庫結構並執行待遷移的 schema 變更。"""
    init_db()
    run_migrations()


# 掛載靜態資源（JS / CSS 編譯包，帶 hash 可永久快取）
if (FRONTEND_DIST_DIR / "assets").exists():
    app.mount(
        "/assets",
        StaticFiles(directory=str(FRONTEND_DIST_DIR / "assets")),
        name="assets"
    )


# SPA catch-all 路由 — 必須放在最後
# 優先嘗試從 frontend/dist/ 直接回傳對應靜態檔（sw.js、workbox-*.js、
# manifest.webmanifest、icons/、offline.html 等 PWA 必要資源），
# 找不到對應實體檔案時才回傳 index.html 讓前端 Router 接管。
@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    """回傳前端靜態檔或 SPA 入口頁面。"""
    if not FRONTEND_DIST_DIR.exists():
        raise HTTPException(status_code=404, detail="Frontend not built. Run build_frontend.bat")

    # 嘗試直接 serve 實體檔案（限制在 dist 目錄內，防止 path traversal）
    if full_path:
        candidate = (FRONTEND_DIST_DIR / full_path).resolve()
        try:
            candidate.relative_to(FRONTEND_DIST_DIR.resolve())
            if candidate.is_file():
                return FileResponse(candidate)
        except ValueError:
            pass  # 路徑逸出 dist 目錄，回退至 SPA

    return FileResponse(FRONTEND_DIST_DIR / "index.html")
