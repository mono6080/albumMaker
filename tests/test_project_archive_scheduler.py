import asyncio

import main


def test_archive_purge_loop_runs_repeatedly_and_closes_each_session(monkeypatch):
    sessions = []
    purge_calls = []

    class FakeSession:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    def fake_session_local():
        session = FakeSession()
        sessions.append(session)
        return session

    def fake_purge(session):
        purge_calls.append(session)

    monkeypatch.setattr(main, "SessionLocal", fake_session_local)
    monkeypatch.setattr(main, "purge_expired_archived_projects", fake_purge)

    async def exercise_loop():
        stop_event = asyncio.Event()
        task = asyncio.create_task(
            main.run_archive_purge_loop(stop_event, interval_seconds=0.001)
        )
        for _ in range(100):
            if purge_calls:
                break
            await asyncio.sleep(0.001)
        stop_event.set()
        await task

    asyncio.run(exercise_loop())

    assert purge_calls
    assert purge_calls == sessions
    assert all(session.closed for session in sessions)


def test_archive_purge_loop_retries_after_failure(monkeypatch):
    attempts = 0

    class FakeSession:
        def close(self):
            pass

    def fake_purge(_session):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary storage failure")

    monkeypatch.setattr(main, "SessionLocal", FakeSession)
    monkeypatch.setattr(main, "purge_expired_archived_projects", fake_purge)

    async def exercise_loop():
        stop_event = asyncio.Event()
        task = asyncio.create_task(
            main.run_archive_purge_loop(stop_event, interval_seconds=0.001)
        )
        for _ in range(100):
            if attempts >= 2:
                break
            await asyncio.sleep(0.001)
        stop_event.set()
        await task

    asyncio.run(exercise_loop())

    assert attempts >= 2
