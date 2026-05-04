"""啟動 Playwright E2E 專用後端。

此腳本使用 repo 內 `.tmp/e2e` 的獨立 SQLite DB 與 uploads 目錄，並將 admin
密碼重設為固定測試值，避免瀏覽器測試碰到開發或正式資料。
"""

import os
import shutil
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT_DIR / "backend"
E2E_TMP_DIR = ROOT_DIR / ".tmp" / "e2e"
E2E_DB_FILE = E2E_TMP_DIR / "e2e.db"
E2E_UPLOADS_DIR = E2E_TMP_DIR / "uploads"
ADMIN_PASSWORD = "admin-password-123"


def configure_environment() -> None:
    if os.environ.get("ALBUM_MAKER_E2E_RESET", "1") != "0":
        shutil.rmtree(E2E_TMP_DIR, ignore_errors=True)
    E2E_TMP_DIR.mkdir(parents=True, exist_ok=True)
    E2E_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("DATABASE_URL", f"sqlite:///{E2E_DB_FILE.as_posix()}")
    os.environ.setdefault("SECRET_KEY", "e2e-secret-do-not-use")
    os.environ.setdefault("ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173")
    os.environ.setdefault("ALBUM_MAKER_UPLOADS_DIR", str(E2E_UPLOADS_DIR))

    sys.path.insert(0, str(BACKEND_DIR))


def reset_admin_password() -> None:
    from auth import hash_password
    from database import SessionLocal, User, init_db
    from migrations import run_migrations

    init_db()
    run_migrations()

    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.username == "admin").one()
        admin.hashed_password = hash_password(ADMIN_PASSWORD)
        db.commit()
    finally:
        db.close()


def main() -> None:
    configure_environment()
    reset_admin_password()

    import uvicorn
    from main import app

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")


if __name__ == "__main__":
    main()
