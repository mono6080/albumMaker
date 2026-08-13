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
# 每個 Playwright worker 一套後端：自己的 port、自己的 SQLite、自己的 uploads。
# 共用一份資料庫會讓測試互相污染——跑越後面的測試要面對前面所有測試累積的資料，
# 同一條測試「單獨跑會過、跑全套會掛」，而且因為怕互相踩只能 workers=1 序列跑。
WORKER_INDEX = int(os.environ.get("ALBUM_MAKER_E2E_INDEX", "0"))
# 本機開發後端佔著 8765 時整組挪開；與 frontend/scripts/e2e-supervisor-utils.mjs 同一個變數
PORT_OFFSET = int(os.environ.get("E2E_PORT_OFFSET", "0"))
BACKEND_PORT = 8765 + PORT_OFFSET + WORKER_INDEX
VITE_BASE_PORT = 5173 + PORT_OFFSET
E2E_TMP_DIR = ROOT_DIR / ".tmp" / "e2e" / f"w{WORKER_INDEX}"
E2E_DB_FILE = E2E_TMP_DIR / "e2e.db"
E2E_UPLOADS_DIR = E2E_TMP_DIR / "uploads"
ADMIN_PASSWORD = "admin-password-123"


def configure_environment() -> None:
    if os.environ.get("ALBUM_MAKER_E2E_RESET", "1") != "0":
        shutil.rmtree(E2E_TMP_DIR, ignore_errors=True)
    E2E_TMP_DIR.mkdir(parents=True, exist_ok=True)
    E2E_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

    # E2E 必須固定使用隔離資源，不能繼承開發或正式環境的連線設定。
    os.environ["DATABASE_URL"] = f"sqlite:///{E2E_DB_FILE.as_posix()}"
    os.environ["SECRET_KEY"] = "e2e-secret-do-not-use"
    os.environ["ALLOWED_ORIGINS"] = (
        f"http://127.0.0.1:{VITE_BASE_PORT},http://localhost:{VITE_BASE_PORT}"
    )
    os.environ["ALBUM_MAKER_UPLOADS_DIR"] = str(E2E_UPLOADS_DIR)

    sys.path.insert(0, str(BACKEND_DIR))


def reset_admin_password() -> None:
    from auth import hash_password
    from database import SessionLocal, User, init_db
    from migrations import rename_tables_to_model_names, run_migrations

    # 與 main.py 的 lifespan 同一個順序：改名必須先於 init_db()
    rename_tables_to_model_names()
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

    uvicorn.run(app, host="127.0.0.1", port=BACKEND_PORT, log_level="warning")


if __name__ == "__main__":
    main()
