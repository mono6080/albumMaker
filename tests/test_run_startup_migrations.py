from scripts import run_startup_migrations


def test_runner_initializes_schema_then_runs_migrations_twice(
    monkeypatch,
    capsys,
):
    calls = []
    monkeypatch.setenv("DATABASE_URL", "sqlite:////app/db/album_maker.db")
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

    assert calls == ["init_db", "run_migrations", "run_migrations"]
    output = capsys.readouterr().out
    assert "run_migrations() 1/2" in output
    assert "run_migrations() 2/2" in output
    assert "兩次 migration 均成功" in output


def test_runner_rejects_arguments_before_database_calls(monkeypatch, capsys):
    calls = []
    monkeypatch.setenv("DATABASE_URL", "sqlite:////app/db/album_maker.db")
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
