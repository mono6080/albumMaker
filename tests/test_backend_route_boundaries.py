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
    _route_decorators,
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


def test_backend_route_boundary_gate_resolves_module_aliases():
    tree = ast.parse(
        """
from services.storage_factory import get_storage as storage_factory
from services.template_sync_locks import lock_template_write as template_lock
indirect_storage = storage_factory
indirect_lock = template_lock
"""
    )
    aliases = _module_aliases(tree)

    assert aliases["indirect_storage"] == "services.storage_factory.get_storage"
    assert aliases["indirect_lock"] == "services.template_sync_locks.lock_template_write"


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


def test_gate_follows_imported_router_local_helpers(monkeypatch):
    """route 不可把禁止操作搬進相鄰 `_helpers.py` 逃過稽核。"""
    test_root = REPO_ROOT / ".tmp" / f"route_gate_{uuid4().hex}"
    backend_root = test_root / "backend"
    routers_root = backend_root / "routers" / "projects"
    routers_root.mkdir(parents=True)
    try:
        (routers_root / "_helpers.py").write_text(
            """
def hidden_commit(db):
    db.commit()
""",
            encoding="utf-8",
        )
        (routers_root / "photos.py").write_text(
            """
from fastapi import APIRouter
from ._helpers import hidden_commit

router = APIRouter()

@router.post("/mutate")
def mutate(db):
    hidden_alias = hidden_commit
    hidden_alias(db)
""",
            encoding="utf-8",
        )
        monkeypatch.setattr(route_gate, "AUDITED_ROOT", backend_root)
        monkeypatch.setattr(
            route_gate,
            "ROUTE_INVENTORY",
            {
                "routers/projects/photos.py": (
                    route_gate.RouteSpec("post", "/mutate", "mutate"),
                )
            },
        )

        errors, debt = route_gate.audit_routes()

        assert errors == [
            "router static boundary 不符：backend/routers/projects/_helpers.py::"
            "hidden_commit::transaction.commit expected=0 actual=1"
        ]
        assert debt == {}
    finally:
        shutil.rmtree(test_root, ignore_errors=True)


def test_gate_rejects_router_helper_storage_and_lock_re_exports(monkeypatch):
    """symbol／namespace re-export 都不能把 Storage／T lock 帶回 router。"""
    test_root = REPO_ROOT / ".tmp" / f"route_gate_{uuid4().hex}"
    backend_root = test_root / "backend"
    routers_root = backend_root / "routers" / "projects"
    routers_root.mkdir(parents=True)
    try:
        (routers_root / "_helpers.py").write_text(
            """
from services.storage_factory import get_storage
import services.storage_factory as storage
from services.template_sync_locks import lock_template_write
""",
            encoding="utf-8",
        )
        (routers_root / "photos.py").write_text(
            """
from fastapi import APIRouter
from ._helpers import get_storage, lock_template_write, storage

router = APIRouter()

@router.post("/mutate")
def mutate():
    get_storage()
    storage.get_storage()
    lock_template_write(1)
""",
            encoding="utf-8",
        )
        monkeypatch.setattr(route_gate, "AUDITED_ROOT", backend_root)
        monkeypatch.setattr(
            route_gate,
            "ROUTE_INVENTORY",
            {
                "routers/projects/photos.py": (
                    route_gate.RouteSpec("post", "/mutate", "mutate"),
                )
            },
        )

        errors, debt = route_gate.audit_routes()

        assert len(errors) == 3
        assert all("forbidden" in error for error in errors)
        assert debt == {}
    finally:
        shutil.rmtree(test_root, ignore_errors=True)


def test_gate_rejects_local_import_default_tuple_and_walrus_aliases(monkeypatch):
    test_root = REPO_ROOT / ".tmp" / f"route_gate_{uuid4().hex}"
    backend_root = test_root / "backend"
    routers_root = backend_root / "routers"
    routers_root.mkdir(parents=True)
    try:
        (routers_root / "known.py").write_text(
            """
from fastapi import APIRouter
from services.storage_factory import get_storage

router = APIRouter()

@router.post("/mutate")
def mutate(default_storage=get_storage):
    from services.storage_factory import get_storage as local_storage
    import services.template_sync_locks as locks
    tuple_storage, tuple_lock = local_storage, locks.lock_template_write
    if (walrus_storage := tuple_storage):
        walrus_storage()
    default_storage()
    tuple_lock(1)
""",
            encoding="utf-8",
        )
        monkeypatch.setattr(route_gate, "AUDITED_ROOT", backend_root)
        monkeypatch.setattr(
            route_gate,
            "ROUTE_INVENTORY",
            {"routers/known.py": (route_gate.RouteSpec("post", "/mutate", "mutate"),)},
        )

        errors, debt = route_gate.audit_routes()

        assert debt == {}
        assert len(errors) == 3
        assert all("forbidden" in error for error in errors)
    finally:
        shutil.rmtree(test_root, ignore_errors=True)


def test_gate_rejects_wildcard_imports_and_unused_nested_transactions(monkeypatch):
    """零 debt 後採 router-source fail-closed，未呼叫 helper 也不可持有 transaction。"""
    test_root = REPO_ROOT / ".tmp" / f"route_gate_{uuid4().hex}"
    backend_root = test_root / "backend"
    routers_root = backend_root / "routers"
    routers_root.mkdir(parents=True)
    try:
        (routers_root / "known.py").write_text(
            """
from fastapi import APIRouter
from .helpers import *

router = APIRouter()

@router.get("/known")
def known(db):
    def unused():
        db.commit()
    hidden_commit = getattr(db, "commit")
    return None
""",
            encoding="utf-8",
        )
        (routers_root / "helpers.py").write_text("VALUE = 1\n", encoding="utf-8")
        monkeypatch.setattr(route_gate, "AUDITED_ROOT", backend_root)
        monkeypatch.setattr(
            route_gate,
            "ROUTE_INVENTORY",
            {"routers/known.py": (route_gate.RouteSpec("get", "/known", "known"),)},
        )

        errors, _ = route_gate.audit_routes()

        assert any("wildcard import" in error for error in errors)
        assert any("transaction.commit" in error for error in errors)
        assert any("dynamic resolution" in error for error in errors)
    finally:
        shutil.rmtree(test_root, ignore_errors=True)


def test_gate_discovers_head_and_api_route_decorators(monkeypatch):
    test_root = REPO_ROOT / ".tmp" / f"route_gate_{uuid4().hex}"
    backend_root = test_root / "backend"
    routers_root = backend_root / "routers"
    routers_root.mkdir(parents=True)
    try:
        (routers_root / "known.py").write_text(
            """
from fastapi import APIRouter

router = APIRouter()

@router.get("/known")
def known():
    return None

@router.head("/health")
def health_head():
    return None

@router.api_route("/multi", methods=["POST", "PATCH"])
def multi():
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

        errors, _ = route_gate.audit_routes()

        assert any("HEAD /health" in error for error in errors)
        assert any("POST /multi" in error for error in errors)
        assert any("PATCH /multi" in error for error in errors)
    finally:
        shutil.rmtree(test_root, ignore_errors=True)


def test_gate_rejects_dynamic_resolution_alias_forms(monkeypatch):
    """動態查找與 import alias 不得繞過 router source gate。"""
    test_root = REPO_ROOT / ".tmp" / f"route_gate_{uuid4().hex}"
    backend_root = test_root / "backend"
    routers_root = backend_root / "routers"
    routers_root.mkdir(parents=True)
    try:
        (routers_root / "known.py").write_text(
            """
from fastapi import APIRouter
import builtins
import importlib as il
from importlib import import_module as load

router = APIRouter()

@router.get("/known")
def known(db):
    resolver = getattr
    resolver(db, "commit")()
    builtins.getattr(db, "commit")()
    il.import_module("services.storage_factory")
    load("services.storage_factory")
    db.__getattribute__("commit")()
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
        joined_errors = "\n".join(errors)

        assert debt == {}
        assert "getattr" in joined_errors
        assert "importlib" in joined_errors
        assert "import_module" in joined_errors
        assert "__getattribute__" in joined_errors
    finally:
        shutil.rmtree(test_root, ignore_errors=True)


def test_render_rollback_allowlist_accepts_only_exact_direct_db_call():
    tree = ast.parse(
        """
def render_all_students(db):
    db.rollback()
"""
    )

    errors = route_gate._static_boundary_errors(
        tree,
        "routers/projects/render.py",
        "routers.projects.render",
        is_package=False,
    )

    assert errors == []


def test_render_rollback_allowlist_rejects_other_receiver():
    tree = ast.parse(
        """
def render_all_students(db, other):
    other.rollback()
"""
    )

    errors = route_gate._static_boundary_errors(
        tree,
        "routers/projects/render.py",
        "routers.projects.render",
        is_package=False,
    )

    assert any("invalid_receiver_or_scope" in error for error in errors)
    assert any("transaction.rollback expected=1 actual=0" in error for error in errors)


def test_render_rollback_allowlist_rejects_nested_helper():
    tree = ast.parse(
        """
def render_all_students(db):
    def helper():
        db.rollback()
    helper()
"""
    )

    errors = route_gate._static_boundary_errors(
        tree,
        "routers/projects/render.py",
        "routers.projects.render",
        is_package=False,
    )

    assert any("invalid_receiver_or_scope" in error for error in errors)
    assert any("transaction.rollback expected=1 actual=0" in error for error in errors)


def test_render_rollback_allowlist_rejects_extra_call():
    tree = ast.parse(
        """
def render_all_students(db):
    db.rollback()
    db.rollback()
"""
    )

    errors = route_gate._static_boundary_errors(
        tree,
        "routers/projects/render.py",
        "routers.projects.render",
        is_package=False,
    )

    assert errors == [
        "router static boundary 不符：backend/routers/projects/render.py::"
        "render_all_students::transaction.rollback expected=1 actual=2"
    ]


def test_render_rollback_allowlist_rejects_function_rename():
    tree = ast.parse(
        """
def renamed(db):
    db.rollback()
"""
    )

    errors = route_gate._static_boundary_errors(
        tree,
        "routers/projects/render.py",
        "routers.projects.render",
        is_package=False,
    )

    assert any("renamed::transaction.rollback.invalid_receiver_or_scope" in error for error in errors)
    assert any("render_all_students::transaction.rollback expected=1 actual=0" in error for error in errors)
