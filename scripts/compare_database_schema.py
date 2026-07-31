"""比對兩個資料庫的 schema，用來證明「升級上來的」與「全新建的」收斂到同一結構。

存在的理由是一類不會報錯的失敗：欄位改名只改了值沒改欄位名、唯一鍵建在只跑得到
舊結構的 migration 裡因此全新資料庫缺了它、索引名沿用舊表名而與新名重複。這些都
不會讓 migration 失敗，只會讓兩條路徑長出不同的資料庫。

用法：

    python scripts/compare_database_schema.py 升級後.db 全新.db

上線前檢查清單第 3 項要求在正式資料副本上跑過完整 migration，再與 `init_db()` 建出
的全新資料庫比對——那一步就是這支腳本。
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path


def snapshot_schema(database_path: str | Path) -> dict[str, dict[str, object]]:
    """讀出表欄位、索引歸屬與 trigger 定義。"""
    connection = sqlite3.connect(str(database_path))
    try:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name NOT LIKE 'sqlite_%'"
            )
        }
        return {
            "tables": {
                table: sorted(
                    row[1] for row in connection.execute(f"PRAGMA table_info({table})")
                )
                for table in tables
            },
            "indexes": {
                name: table
                for name, table in connection.execute(
                    "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' "
                    "AND name NOT LIKE 'sqlite_%'"
                )
            },
            "triggers": {
                name: " ".join((sql or "").split())
                for name, sql in connection.execute(
                    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'"
                )
            },
        }
    finally:
        connection.close()


def diff_schemas(
    upgraded: dict[str, dict[str, object]],
    fresh: dict[str, dict[str, object]],
) -> list[str]:
    """回傳人看得懂的差異描述；相同時回傳空 list。"""
    differences: list[str] = []
    for kind in ("tables", "indexes", "triggers"):
        upgraded_part = upgraded[kind]
        fresh_part = fresh[kind]
        for name in sorted(set(upgraded_part) - set(fresh_part)):
            differences.append(f"{kind}: {name} 只在升級後的資料庫存在")
        for name in sorted(set(fresh_part) - set(upgraded_part)):
            differences.append(f"{kind}: {name} 只在全新資料庫存在")
        for name in sorted(set(upgraded_part) & set(fresh_part)):
            if upgraded_part[name] != fresh_part[name]:
                differences.append(
                    f"{kind}: {name} 定義不同\n"
                    f"    升級後 = {upgraded_part[name]}\n"
                    f"    全新   = {fresh_part[name]}"
                )
    return differences


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("upgraded", help="跑過完整 migration 的資料庫")
    parser.add_argument("fresh", help="由 init_db() 建出的全新資料庫")
    arguments = parser.parse_args()

    differences = diff_schemas(
        snapshot_schema(arguments.upgraded),
        snapshot_schema(arguments.fresh),
    )
    if not differences:
        print("兩個資料庫的表欄位、索引與 trigger 完全一致。")
        return 0
    print(f"發現 {len(differences)} 項差異：")
    for difference in differences:
        print(f"  - {difference}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
