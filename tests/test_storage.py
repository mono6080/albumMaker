# Storage adapter 基礎驗證
# 涵蓋 LocalStorageAdapter 的 put/get/exists/delete 完整生命週期，以及 path traversal 防護

import pytest

from services.storage import LocalStorageAdapter


def test_local_storage_put_get_delete(tmp_path):
    """put → exists → get_bytes → delete → exists False 的完整生命週期。"""
    adapter = LocalStorageAdapter(tmp_path)
    key = "foo/bar.txt"

    adapter.put(key, b"hi")
    assert adapter.exists(key) is True
    assert adapter.get_bytes(key) == b"hi"

    adapter.delete(key)
    assert adapter.exists(key) is False


def test_local_storage_path_traversal_blocked(tmp_path):
    """含 ../ 的 key 必須被 _path() 攔截並拋出 ValueError。"""
    adapter = LocalStorageAdapter(tmp_path)
    with pytest.raises(ValueError):
        adapter.put("../../etc/passwd", b"x")
