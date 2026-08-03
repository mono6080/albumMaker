# Pytest 共用設定
# 必須在 import 任何 backend 模組之前執行 —— database.py 在 import 時就讀取
# DATABASE_URL 並建立 engine，conftest 是唯一保證早於測試模組 import 的時機。

import os
import shutil
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
# pytest-xdist 的 worker 是獨立 process，但會**繼承 controller 的環境變數**——
# 若沿用 setdefault，四個 worker 會全部指向 controller 那一份資料庫而互相踩。
# 有 worker id 就以它命名資料夾並強制覆寫連線字串。
_WORKER_ID = os.environ.get("PYTEST_XDIST_WORKER")
_TEST_TMP_DIR = _TEST_TMP_ROOT / (
    f"album_maker_tests_{_WORKER_ID}" if _WORKER_ID else f"album_maker_tests_{uuid4().hex}"
)
if _WORKER_ID:
    shutil.rmtree(_TEST_TMP_DIR, ignore_errors=True)
_TEST_TMP_DIR.mkdir(parents=True, exist_ok=bool(_WORKER_ID))
_TEST_DB_FILE = _TEST_TMP_DIR / "test.db"
_PRISTINE_DB_FILE = _TEST_TMP_DIR / "pristine.db"

if _WORKER_ID:
    os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB_FILE.as_posix()}"
    # 上傳目錄同理：共用會讓不同 worker 的檔案互相看見
    os.environ["ALBUM_MAKER_UPLOADS_DIR"] = str(_TEST_TMP_DIR / "uploads")
else:
    os.environ.setdefault("DATABASE_URL", f"sqlite:///{_TEST_DB_FILE.as_posix()}")
os.environ.setdefault("SECRET_KEY", "test-secret-do-not-use")
# 啟動收斂掃描在測試停用(每個 started_client 都會走 lifespan);專測時直接呼叫函式
os.environ.setdefault("RENDER_RECONCILE_ON_STARTUP", "0")

import pytest  # noqa: E402


def _database_files(base: Path) -> list[Path]:
    """WAL 模式下 -wal／-shm 與主檔是一組，複製與清除都要一起處理。"""
    return [base, base.with_name(base.name + "-wal"), base.with_name(base.name + "-shm")]


def _copy_database(source_base: Path, target_base: Path) -> None:
    for source in _database_files(source_base):
        target = target_base.with_name(
            source.name.replace(source_base.name, target_base.name, 1)
        )
        target.unlink(missing_ok=True)
        if source.exists():
            shutil.copy2(source, target)


@pytest.fixture(autouse=True)
def _isolated_database():
    """每個測試都從同一份乾淨的已遷移資料庫開始。

    班級改成學期範圍實體之後，套用編班會關閉目前學期、開新學期——先前建立的班級
    就永久屬於歷史學期。那是模型的正確行為，但共用同一個 DB 檔會讓編班測試污染
    其後的所有測試。每個測試重跑 migration 太慢，所以只建一次 pristine 檔再逐測試複製。
    """
    from database import engine

    if not _PRISTINE_DB_FILE.exists():
        from database import init_db
        from migrations import run_migrations

        init_db()
        run_migrations()
        engine.dispose()
        _copy_database(_TEST_DB_FILE, _PRISTINE_DB_FILE)
    else:
        engine.dispose()
        _copy_database(_PRISTINE_DB_FILE, _TEST_DB_FILE)
    yield
    engine.dispose()


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
