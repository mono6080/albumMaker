"""孩子姓名正規化。"""

import re


_WHITESPACE_PATTERN = re.compile(r"[\s　]+")


def normalize_child_name(raw_name: str) -> str:
    """姓名正規化：移除所有空白（含全形），作為名冊身分姓名。"""
    return _WHITESPACE_PATTERN.sub("", raw_name or "")
