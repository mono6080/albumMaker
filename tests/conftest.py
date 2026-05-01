# Pytest 共用設定
# 必須在 import 任何 backend 模組之前執行 —— database.py 在 import 時就讀取
# DATABASE_URL 並建立 engine，conftest 是唯一保證早於測試模組 import 的時機。

import os
import tempfile
from pathlib import Path

# 為整個 test session 配置一個 tmp DB 檔案，避免污染 backend/album_maker.db
_TEST_TMP_DIR = Path(tempfile.mkdtemp(prefix="album_maker_tests_"))
_TEST_DB_FILE = _TEST_TMP_DIR / "test.db"

os.environ.setdefault("DATABASE_URL", f"sqlite:///{_TEST_DB_FILE.as_posix()}")
os.environ.setdefault("SECRET_KEY", "test-secret-do-not-use")
