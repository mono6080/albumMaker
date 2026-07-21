# Pytest 共用設定
# 必須在 import 任何 backend 模組之前執行 —— database.py 在 import 時就讀取
# DATABASE_URL 並建立 engine，conftest 是唯一保證早於測試模組 import 的時機。

import os
from pathlib import Path
from uuid import uuid4

# 為整個 test session 配置一個 repo 內 tmp DB 檔案，避免污染 backend/album_maker.db。
# 預設不用系統 TEMP，讓 sandbox / CI 權限較受限時也能直接跑 pytest。
_TEST_TMP_ROOT = Path(
    os.environ.get(
        "ALBUM_MAKER_TEST_TMPDIR",
        Path(__file__).resolve().parents[1] / ".tmp" / "pytest",
    )
)
_TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
_TEST_TMP_DIR = _TEST_TMP_ROOT / f"album_maker_tests_{uuid4().hex}"
_TEST_TMP_DIR.mkdir(parents=True, exist_ok=False)
_TEST_DB_FILE = _TEST_TMP_DIR / "test.db"

os.environ.setdefault("DATABASE_URL", f"sqlite:///{_TEST_DB_FILE.as_posix()}")
os.environ.setdefault("SECRET_KEY", "test-secret-do-not-use")
# 啟動收斂掃描在測試停用(每個 started_client 都會走 lifespan);專測時直接呼叫函式
os.environ.setdefault("RENDER_RECONCILE_ON_STARTUP", "0")

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _disable_completion_background_render(monkeypatch):
    """完成觸發的背景渲染預設停用：daemon 執行緒的真渲染會拖慢並干擾測試資料。

    專測觸發行為的測試自行 monkeypatch 成 recorder 覆寫此 no-op。
    """
    from services import completion_render_service

    monkeypatch.setattr(
        completion_render_service,
        "queue_background_student_renders",
        lambda *args, **kwargs: None,
    )
