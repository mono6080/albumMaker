"""模板與專案 JSON 的 process-local 寫鎖。

目前部署採單一 uvicorn worker；這些鎖與 student_pages 的寫鎖一起防止完整 JSON
read-modify-write 互相覆蓋。SQLite transaction 仍是跨資料列 all-or-none 的最終保證。
"""

import threading
from contextlib import contextmanager


_template_locks: dict[int, threading.Lock] = {}
_template_locks_guard = threading.Lock()
_project_locks: dict[int, threading.Lock] = {}
_project_locks_guard = threading.Lock()


def _lock_for(registry, guard, item_id: int) -> threading.Lock:
    with guard:
        return registry.setdefault(item_id, threading.Lock())


@contextmanager
def lock_template_write(template_id: int):
    lock = _lock_for(_template_locks, _template_locks_guard, template_id)
    with lock:
        yield


@contextmanager
def lock_project_content_writes(project_ids):
    locks = [
        _lock_for(_project_locks, _project_locks_guard, project_id)
        for project_id in sorted(set(project_ids))
    ]
    for lock in locks:
        lock.acquire()
    try:
        yield
    finally:
        for lock in reversed(locks):
            lock.release()
