"""園所編制與名單 mutation 的共同交易邊界。"""

from contextlib import contextmanager
from functools import wraps

from sqlalchemy import text

from services.organization_lock import organization_acl_lock


@contextmanager
def organization_write_transaction(db):
    """取得 process lock 並以 SQLite immediate transaction 重讀目前狀態。"""
    with organization_acl_lock:
        db.rollback()
        db.expire_all()
        db.execute(text("BEGIN IMMEDIATE"))
        try:
            yield
        except Exception:
            db.rollback()
            raise


def organization_mutation(function):
    """讓既有第一個參數為 Session 的 use case 共用相同鎖與交易起點。"""
    @wraps(function)
    def wrapped(db, *args, **kwargs):
        with organization_write_transaction(db):
            return function(db, *args, **kwargs)

    return wrapped
