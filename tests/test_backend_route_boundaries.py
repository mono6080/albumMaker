"""後端 audited routers 的 deterministic AST boundary gate。"""

import ast
import shutil
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

from scripts import check_backend_route_boundaries as route_gate
from scripts.check_backend_route_boundaries import (
    _module_aliases,
    _module_functions,
    _operation,
    _route_decorators,
    _route_aliases,
    _route_operations,
)


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_backend_route_boundary_gate_is_clean():
    result = subprocess.run(
        [sys.executable, "scripts/check_backend_route_boundaries.py"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_backend_route_boundary_gate_resolves_import_and_function_aliases():
    tree = ast.parse(
        """
from services.storage_factory import get_storage as storage_factory
from services.template_sync_locks import lock_template_write as template_lock

def route(db):
    indirect_storage = storage_factory
    indirect_commit = db.commit
    indirect_lock = template_lock
    indirect_storage()
    indirect_commit()
    indirect_lock(1)
"""
    )
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef))
    aliases = _route_aliases(function, _module_aliases(tree))
    operations = [
        operation
        for node in ast.walk(function)
        if isinstance(node, ast.Call)
        if (operation := _operation(node, aliases)) is not None
    ]

    assert operations == [
        "storage.get_storage",
        "transaction.commit",
        "lock.template",
    ]


def test_gate_discovers_aliased_router_namespace_and_route_helper_operations():
    tree = ast.parse(
        """
import fastapi as web
import services.storage_factory as storage_namespace

RouterFactory = web.APIRouter
primary_api = RouterFactory()
published_api = primary_api
storage_alias = storage_namespace

def mutation_helper(db):
    db.commit()
    storage_alias.get_storage()

helper_alias = mutation_helper

@published_api.post("/mutate")
def endpoint(db):
    helper_alias(db)
"""
    )
    aliases = _module_aliases(tree)
    functions = _module_functions(tree)

    assert _route_decorators(functions["endpoint"], aliases) == [("post", "/mutate")]
    assert _route_operations(functions["endpoint"], aliases, functions) == {
        "transaction.commit": 1,
        "storage.get_storage": 1,
    }


def test_gate_rejects_new_route_file_anywhere_under_backend_routers(monkeypatch):
    test_root = REPO_ROOT / ".tmp" / f"route_gate_{uuid4().hex}"
    backend_root = test_root / "backend"
    routers_root = backend_root / "routers"
    routers_root.mkdir(parents=True)
    try:
        (routers_root / "known.py").write_text(
            """
from fastapi import APIRouter
api = APIRouter()

@api.get("/known")
def known():
    return None
""",
            encoding="utf-8",
        )
        (routers_root / "escaped.py").write_text(
            """
import fastapi as web
Factory = web.APIRouter
hidden_api = Factory()

@hidden_api.post("/escaped")
def escaped():
    return None
""",
            encoding="utf-8",
        )
        monkeypatch.setattr(route_gate, "AUDITED_ROOT", backend_root)
        monkeypatch.setattr(
            route_gate,
            "ROUTE_INVENTORY",
            {"routers/known.py": (route_gate.RouteSpec("get", "/known", "known"),)},
        )

        errors, debt = route_gate.audit_routes()

        assert debt == {}
        assert errors == ["未分類 audited router 檔案：backend/routers/escaped.py"]
    finally:
        shutil.rmtree(test_root, ignore_errors=True)
