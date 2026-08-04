import ast
import pathlib

from scripts import run_startup_migrations


def test_runner_renames_then_initializes_schema_then_migrates_twice(
    monkeypatch,
    capsys,
):
    calls = []
    monkeypatch.setenv("DATABASE_URL", "sqlite:////app/db/album_maker.db")
    monkeypatch.setattr(
        run_startup_migrations,
        "rename_tables_to_model_names",
        lambda: calls.append("rename_tables_to_model_names"),
    )
    monkeypatch.setattr(
        run_startup_migrations,
        "init_db",
        lambda: calls.append("init_db"),
    )
    monkeypatch.setattr(
        run_startup_migrations,
        "run_migrations",
        lambda: calls.append("run_migrations"),
    )

    assert run_startup_migrations.main([]) == 0

    assert calls == [
        "rename_tables_to_model_names",
        "init_db",
        "run_migrations",
        "run_migrations",
    ]
    output = capsys.readouterr().out
    assert "run_migrations() 1/2" in output
    assert "run_migrations() 2/2" in output
    assert "兩次 migration 均成功" in output


def test_runner_rejects_arguments_before_database_calls(monkeypatch, capsys):
    calls = []
    monkeypatch.setenv("DATABASE_URL", "sqlite:////app/db/album_maker.db")
    monkeypatch.setattr(
        run_startup_migrations,
        "rename_tables_to_model_names",
        lambda: calls.append("rename_tables_to_model_names"),
    )
    monkeypatch.setattr(
        run_startup_migrations,
        "init_db",
        lambda: calls.append("init_db"),
    )
    monkeypatch.setattr(
        run_startup_migrations,
        "run_migrations",
        lambda: calls.append("run_migrations"),
    )

    assert run_startup_migrations.main(["--db", "other.db"]) == 2

    assert calls == []
    assert "不接受命令列參數" in capsys.readouterr().err


def test_runner_requires_explicit_database_url(monkeypatch, capsys):
    calls = []
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(
        run_startup_migrations,
        "rename_tables_to_model_names",
        lambda: calls.append("rename_tables_to_model_names"),
    )
    monkeypatch.setattr(
        run_startup_migrations,
        "init_db",
        lambda: calls.append("init_db"),
    )
    monkeypatch.setattr(
        run_startup_migrations,
        "run_migrations",
        lambda: calls.append("run_migrations"),
    )

    assert run_startup_migrations.main([]) == 2

    assert calls == []
    assert "未設定 DATABASE_URL" in capsys.readouterr().err


def _schema_setup_call_order(source_path, function_name):
    """從原始碼取出某個函式裡 schema 初始化三步的呼叫順序。

    用 AST 而不是 monkeypatch 比對：這條測試要防的是「腳本與 main.py 的順序飄開」，
    而兩邊各自的 mock 測試永遠只會驗到自己被寫成什麼樣子——2026-08 就是這樣讓腳本
    漏掉改名而沒有任何測試變紅。
    """
    tracked = {"rename_tables_to_model_names", "init_db", "run_migrations"}
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name == function_name:
            return [
                call.func.id
                for call in ast.walk(node)
                if isinstance(call, ast.Call)
                and isinstance(call.func, ast.Name)
                and call.func.id in tracked
            ]
    raise AssertionError(f"{source_path} 裡找不到 {function_name}()")


def test_runner_schema_order_matches_main_lifespan():
    """腳本與正式啟動必須做同一件事，否則 maintenance window 驗過的不算數。

    改名要先於 init_db()：`create_all` 只看表存不存在，改名還沒發生時它會用新名字
    建空表；而索引名在 SQLite 是整個資料庫唯一的，舊表上的同名索引還在就直接失敗。
    """
    repo_root = pathlib.Path(__file__).resolve().parents[1]
    lifespan = _schema_setup_call_order(repo_root / "backend" / "main.py", "lifespan")
    runner = _schema_setup_call_order(
        repo_root / "scripts" / "run_startup_migrations.py", "main"
    )

    assert lifespan[:2] == ["rename_tables_to_model_names", "init_db"]
    # 腳本的第二次 run_migrations() 寫在迴圈裡，原始碼上仍是同一個呼叫點；
    # 「刻意跑兩次驗冪等」由上面的 monkeypatch 測試釘住，這裡只比步驟與順序。
    assert runner == lifespan
