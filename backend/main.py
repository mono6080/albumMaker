# 應用程式進入點
# 負責建立 FastAPI 實例、掛載中介層、路由與靜態檔案服務，
# 以及啟動時執行資料庫初始化與遷移

import asyncio
import logging
import mimetypes
import os
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import text

from database import SessionLocal, get_db, init_db
from migrations import run_migrations
from routers import auth, organization, projects, roster, templates, users
from services.completion_render_service import start_render_reconciliation_thread
from services.project_archive_service import purge_expired_archived_projects

logger = logging.getLogger("album_maker.requests")

# Windows 的 mimetypes registry 不一定包含 web font，先固定 StaticFiles 回應型別。
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/ttf", ".ttf")


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
FRONTEND_REVALIDATED_ASSET_CACHE_CONTROL = "public, no-cache, must-revalidate"
FRONTEND_APP_CACHE_CONTROL = "no-cache, no-store, max-age=0, must-revalidate"
SLOW_REQUEST_LOG_SECONDS = _env_float("SLOW_REQUEST_LOG_SECONDS", 1.0)
ARCHIVE_PURGE_INTERVAL_SECONDS = max(
    1.0,
    _env_float("ARCHIVE_PURGE_INTERVAL_SECONDS", 300.0),
)


def _purge_expired_archived_projects_once() -> None:
    """以獨立 session 執行一次到期清理，供啟動與背景循環共用。"""
    db = SessionLocal()
    try:
        purge_expired_archived_projects(db)
    finally:
        db.close()


async def run_archive_purge_loop(
    stop_event: asyncio.Event,
    *,
    interval_seconds: float = ARCHIVE_PURGE_INTERVAL_SECONDS,
) -> None:
    """服務存活期間定時清除到期封存相本；單次失敗不終止後續清理。"""
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(
                stop_event.wait(),
                timeout=max(0.001, interval_seconds),
            )
            break
        except TimeoutError:
            pass
        try:
            await asyncio.to_thread(_purge_expired_archived_projects_once)
        except Exception:
            logger.exception("定時清理到期封存相本失敗；下個週期會重試")


def apply_frontend_cache_headers(response, path: str) -> None:
    """Set cache policy for frontend files without touching API responses."""
    if path.startswith("/api/"):
        return

    if path.startswith("/assets/"):
        response.headers["Cache-Control"] = FRONTEND_ASSET_CACHE_CONTROL
        return
    if path.startswith("/fonts/"):
        response.headers["Cache-Control"] = FRONTEND_REVALIDATED_ASSET_CACHE_CONTROL
        return

    # SPA routes, index.html, service workers, Workbox chunks, manifest, and
    # other root-level PWA files must be revalidated after every deploy.
    response.headers["Cache-Control"] = FRONTEND_APP_CACHE_CONTROL
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    if path == "/sw.js":
        response.headers["Service-Worker-Allowed"] = "/"


@asynccontextmanager
async def lifespan(_: FastAPI):
    """初始化 schema／migration，並在啟動時清理到期封存資料。"""
    init_db()
    run_migrations()
    _purge_expired_archived_projects_once()
    # 啟動收斂:背景補渲有效完成但輸出過期的學生(部署後的 warm-up 也由此涵蓋)
    start_render_reconciliation_thread()
    archive_purge_stop = asyncio.Event()
    archive_purge_task = asyncio.create_task(
        run_archive_purge_loop(archive_purge_stop),
        name="archive-project-purge",
    )
    try:
        yield
    finally:
        archive_purge_stop.set()
        await archive_purge_task


app = FastAPI(title="幼兒園相本製作系統", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """為所有回應加入基本安全 HTTP Headers，防止 Clickjacking、MIME sniffing 等攻擊。"""
    async def dispatch(self, request: Request, call_next):
        started_at = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            logger.exception("unhandled_request method=%s path=%s", request.method, request.url.path)
            raise
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
app.include_router(organization.router)


@app.get("/api/health")
def health_check(db=Depends(get_db)):
    """健康檢查同時驗證 API 與 SQLite 連線。"""
    db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "ok"}


# 掛載靜態資源（JS / CSS 編譯包，帶 hash 可永久快取）
if (FRONTEND_DIST_DIR / "assets").exists():
    app.mount(
        "/assets",
        StaticFiles(directory=str(FRONTEND_DIST_DIR / "assets")),
        name="assets"
    )

# 共用渲染字型檔名固定，不能用 immutable；交給 StaticFiles 處理
# ETag / If-None-Match，部署後會重驗證但未變更時只回 304。
if (FRONTEND_DIST_DIR / "fonts").exists():
    app.mount(
        "/fonts",
        StaticFiles(directory=str(FRONTEND_DIST_DIR / "fonts")),
        name="fonts",
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
