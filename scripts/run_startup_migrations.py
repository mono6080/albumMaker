"""在 maintenance window 內執行 candidate image 的 startup schema migration。"""

import os
import sys
from collections.abc import Sequence
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = APP_ROOT / "backend"
IMPORT_ROOT = BACKEND_DIR if (BACKEND_DIR / "database.py").is_file() else APP_ROOT
if str(IMPORT_ROOT) not in sys.path:
    sys.path.insert(0, str(IMPORT_ROOT))

from database import init_db
from migrations import run_migrations


def main(arguments: Sequence[str] | None = None) -> int:
    """建立 ORM schema，再刻意重跑 migration 兩次驗證冪等性。"""
    cli_arguments = list(sys.argv[1:] if arguments is None else arguments)
    if cli_arguments:
        print(
            "錯誤：本腳本不接受命令列參數；資料庫只由 DATABASE_URL 決定。",
            file=sys.stderr,
        )
        return 2
    if not os.environ.get("DATABASE_URL"):
        print(
            "錯誤：未設定 DATABASE_URL，拒絕使用 database.py 的開發預設路徑。",
            file=sys.stderr,
        )
        return 2

    print("startup schema migration：已讀取 DATABASE_URL（值不顯示）。")
    print("startup schema migration：執行 init_db()。")
    init_db()
    for pass_number in range(1, 3):
        print(f"startup schema migration：執行 run_migrations() {pass_number}/2。")
        run_migrations()
    print("startup schema migration：完成；兩次 migration 均成功。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
