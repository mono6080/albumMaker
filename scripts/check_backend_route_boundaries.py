"""以 AST 稽核完整 route inventory 與零債務 HTTP adapter 邊界。

所有 ``backend/routers/**/*.py`` 採 source-level fail-closed：禁止 transaction attribute、
Storage／lock owner import、wildcard 與動態解析。唯一例外是 render_all 的一筆 rollback；
因此 helper re-export、local import 或未呼叫 nested helper 都不能藏住禁止操作。
"""

from __future__ import annotations

import argparse
import ast
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
AUDITED_ROOT = REPO_ROOT / "backend"

AUDITED = "audited"
PREVIEW_CACHE = "preview_cache"
RENDER_ALL = "render_all"
ROUTER_INSTANCE = "<fastapi.APIRouter instance>"


@dataclass(frozen=True)
class RouteSpec:
    method: str
    path: str
    function: str
    policy: str = AUDITED


def _routes(*items: tuple[str, str, str] | tuple[str, str, str, str]) -> tuple[RouteSpec, ...]:
    return tuple(RouteSpec(*item) for item in items)


ROUTE_INVENTORY: dict[str, tuple[RouteSpec, ...]] = {
    "routers/projects/crud.py": _routes(
        ("get", "/", "list_projects"),
        ("get", "/archive", "list_archived_projects"),
        ("get", "/{project_id}", "get_project"),
        ("get", "/{project_id}/students/{student_id}/editor", "get_student_editor_detail"),
        ("patch", "/{project_id}", "rename_project"),
        ("delete", "/{project_id}", "delete_project"),
        ("post", "/{project_id}/restore", "restore_project"),
        ("post", "/{project_id}/complete", "complete_project"),
        ("post", "/{project_id}/reopen", "reopen_project"),
        (
            "post",
            "/{project_id}/students/{student_id}/complete",
            "complete_project_student",
        ),
        (
            "post",
            "/{project_id}/students/{student_id}/reopen",
            "reopen_project_student",
        ),
        (
            "post",
            "/{project_id}/students/album-names/auto-fill",
            "auto_fill_student_album_names",
        ),
        (
            "post",
            "/{project_id}/students/{student_id}/album-name/auto-fill",
            "auto_fill_student_album_name",
        ),
        (
            "put",
            "/{project_id}/students/{student_id}/album-name",
            "update_student_album_name",
        ),
        (
            "patch",
            "/{project_id}/students/{student_id}/pages/{page_index}/skip",
            "set_page_skip",
        ),
    ),
    "routers/projects/photos.py": _routes(
        (
            "post",
            "/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}",
            "upload_photo",
        ),
        (
            "post",
            "/{project_id}/photos/shared/pages/{page_index}/slots/{slot_id}",
            "upload_shared_project_photo",
        ),
        (
            "post",
            "/{project_id}/photos/batch/pages/{page_index}/slots/{slot_id}",
            "batch_upload_photos",
        ),
        (
            "get",
            "/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}",
            "get_photo",
        ),
        (
            "get",
            "/{project_id}/students/{student_id}/pages/{page_index}/photos/{slot_id}/thumbnail",
            "get_photo_thumbnail",
            PREVIEW_CACHE,
        ),
        (
            "put",
            "/{project_id}/students/{student_id}/photos/mapping",
            "update_photo_mapping",
        ),
    ),
    "routers/projects/texts.py": _routes(
        ("get", "/{project_id}/label_texts", "get_project_label_texts"),
        ("put", "/{project_id}/label_texts", "update_project_label_texts"),
        (
            "put",
            "/{project_id}/students/{student_id}/pages/{page_index}/texts",
            "update_student_label_texts",
        ),
        ("put", "/{project_id}/batch/texts", "batch_update_texts"),
    ),
    "routers/projects/comments.py": _routes(
        ("get", "/{project_id}/comments", "list_comments"),
        ("post", "/{project_id}/comments", "add_comment"),
        ("delete", "/{project_id}/comments/{comment_id}", "delete_comment"),
    ),
    "routers/projects/assignments.py": _routes(
        ("post", "/{project_id}/assignment", "assign_project_owner"),
        (
            "get",
            "/{project_id}/assignment-history",
            "list_project_assignment_history",
        ),
    ),
    "routers/projects/render.py": _routes(
        ("get", "/{project_id}/preview/{page_index}", "preview_project_page", PREVIEW_CACHE),
        (
            "get",
            "/{project_id}/students/{student_id}/preview/{page_index}",
            "preview_student_page",
            PREVIEW_CACHE,
        ),
        ("post", "/{project_id}/students/{student_id}/render", "render_student"),
        ("post", "/{project_id}/render/all", "render_all_students", RENDER_ALL),
        ("get", "/{project_id}/students/{student_id}/pdf", "download_student_pdf"),
        ("get", "/{project_id}/students/{student_id}/images", "download_student_images_as_zip"),
        (
            "get",
            "/{project_id}/students/{student_id}/images/{page_number}",
            "download_student_image",
        ),
        ("get", "/{project_id}/download/all", "download_all_pdfs_as_zip"),
        ("get", "/{project_id}/download/all/images", "download_all_images_as_zip"),
        ("get", "/{project_id}/photos/archive", "download_all_uploaded_photos_as_zip"),
        (
            "get",
            "/{project_id}/students/{student_id}/photos/archive",
            "download_student_uploaded_photos_as_zip",
        ),
    ),
    "routers/templates/crud.py": _routes(
        ("get", "/", "list_templates"),
        ("post", "/", "create_template"),
        ("patch", "/{template_id}", "rename_template"),
        ("get", "/{template_id}", "get_template"),
        ("delete", "/{template_id}", "delete_template"),
        ("put", "/{template_id}/pages", "replace_pages_snapshot"),
        ("post", "/{template_id}/pages", "add_page"),
        ("put", "/{template_id}/pages/{page_id}/layout", "update_page_layout"),
        ("delete", "/{template_id}/pages/{page_id}", "delete_page"),
    ),
    "routers/templates/assets.py": _routes(
        ("post", "/{template_id}/pages/{page_id}/background", "upload_background"),
        ("get", "/{template_id}/pages/{page_id}/background", "get_background"),
        ("post", "/{template_id}/stickers", "upload_sticker"),
        (
            "post",
            "/{template_id}/pages/{page_id}/material-text-box-suggestion",
            "suggest_material_text_box",
        ),
        ("get", "/{template_id}/stickers/{filename}", "get_sticker"),
    ),
    "routers/templates/periods.py": _routes(
        ("get", "/departments", "list_template_departments"),
        ("get", "/periods", "list_template_periods"),
        ("post", "/periods", "create_template_period"),
        ("patch", "/periods/{period_id}", "update_template_period"),
    ),
    "routers/templates/render.py": _routes(
        (
            "get",
            "/{template_id}/pages/{page_id}/preview",
            "preview_template_page",
            PREVIEW_CACHE,
        ),
        (
            "get",
            "/{template_id}/spread-preview/{start_page_index}",
            "preview_template_spread",
            PREVIEW_CACHE,
        ),
    ),
    "routers/users.py": _routes(
        ("get", "/", "list_users"),
        ("post", "/", "create_user"),
        ("post", "/import", "import_users_from_excel"),
        ("patch", "/me/settings", "update_my_settings"),
        ("patch", "/{user_id}", "update_user"),
        ("delete", "/{user_id}", "delete_user"),
    ),
    "routers/roster.py": _routes(
        ("get", "/semesters", "get_reporting_semesters"),
        ("get", "/semester-export", "get_semester_export_preview"),
        ("get", "/teacher-progress", "get_teacher_progress"),
        ("get", "/teacher-overview/export", "export_teacher_overview_excel"),
        ("post", "/semester-export/render-missing", "render_missing_albums"),
        (
            "get",
            "/semester-export/render-missing/{job_id}",
            "get_render_missing_progress",
        ),
        ("get", "/semester-export/download", "download_semester_export_zip"),
    ),
    "routers/auth.py": _routes(
        ("post", "/login", "login"),
        ("post", "/logout", "logout"),
        ("get", "/me", "get_me"),
    ),
    "routers/organization.py": _routes(
        ("get", "/overview", "get_organization_overview"),
        ("get", "/my-classrooms", "get_my_classrooms"),
        ("get", "/semesters", "list_semesters"),
        ("post", "/campuses", "create_campus"),
        ("patch", "/campuses/{campus_id}", "update_campus"),
        (
            "put",
            "/campuses/{campus_id}/supervisors",
            "replace_campus_supervisors",
        ),
        ("post", "/classrooms", "create_classroom"),
        ("patch", "/classrooms/{classroom_id}", "update_classroom"),
        (
            "post",
            "/classrooms/{classroom_id}/members/batch",
            "batch_add_classroom_members",
        ),
        (
            "patch",
            "/classrooms/{classroom_id}/members/{member_id}",
            "update_classroom_member",
        ),
        (
            "post",
            "/classrooms/{classroom_id}/members/album-names/auto-fill",
            "auto_fill_classroom_member_album_names",
        ),
        (
            "patch",
            "/students/{roster_child_id}/album-name",
            "update_roster_child_album_name",
        ),
        (
            "post",
            "/students/{roster_child_id}/album-name/auto-fill",
            "auto_fill_roster_child_album_name",
        ),
        (
            "post",
            "/classrooms/{classroom_id}/projects",
            "create_classroom_project",
        ),
        (
            "put",
            "/classrooms/{classroom_id}/teachers",
            "replace_classroom_teachers",
        ),
        (
            "post",
            "/term-reclassification-plans",
            "create_term_reclassification_plan",
        ),
        (
            "get",
            "/term-reclassification-plans/{plan_id}",
            "get_term_reclassification_plan",
        ),
        (
            "put",
            "/term-reclassification-plans/{plan_id}",
            "update_term_reclassification_plan",
        ),
        (
            "post",
            "/term-reclassification-plans/{plan_id}/validate",
            "validate_term_reclassification_plan",
        ),
        (
            "post",
            "/term-reclassification-plans/{plan_id}/apply",
            "apply_term_reclassification_plan",
        ),
        (
            "post",
            "/term-reclassification-plans/{plan_id}/cancel",
            "cancel_term_reclassification_plan",
        ),
    ),
}


# 格式："相對路徑::route function::操作種類": 精確呼叫次數。
# 只容納尚未下移的歷史 debt；新 use-case 不得加入這裡掩蓋回歸。
EXPECTED_DEBT: dict[str, int] = {}

TRANSACTION_METHODS = {"commit", "rollback", "flush"}
STORAGE_FACTORIES = {
    "services.storage.get_storage",
    "services.storage_factory.get_storage",
}
LOCK_SYMBOLS = {
    "services.template_sync_locks.lock_template_write": "lock.template",
    "services.template_sync_locks.lock_project_content_writes": "lock.project",
    "services.student_pages.lock_student_page_writes": "lock.student",
    "services.project_template_revision.lock_project_template_revision": "lock.project_template_revision",
    "services.student_render_service._lock_student_render": "lock.render",
}
def _qualified_name(node: ast.AST, aliases: dict[str, str]) -> str | None:
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        base = _qualified_name(node.value, aliases)
        return f"{base}.{node.attr}" if base else None
    return None


def _resolve_import_module(
    module_name: str | None,
    imported_module: str | None,
    level: int,
    *,
    is_package: bool = False,
) -> str | None:
    if level == 0:
        return imported_module
    if module_name is None:
        return imported_module
    package_parts = module_name.split(".") if is_package else module_name.split(".")[:-1]
    parent_count = level - 1
    if parent_count > len(package_parts):
        return imported_module
    base_parts = package_parts[: len(package_parts) - parent_count]
    if imported_module:
        base_parts.extend(imported_module.split("."))
    return ".".join(base_parts)


def _bind_alias(
    target: ast.AST,
    value: ast.AST,
    aliases: dict[str, str],
) -> bool:
    if (
        isinstance(target, (ast.Tuple, ast.List))
        and isinstance(value, (ast.Tuple, ast.List))
        and len(target.elts) == len(value.elts)
    ):
        return any(
            _bind_alias(target_item, value_item, aliases)
            for target_item, value_item in zip(target.elts, value.elts, strict=True)
        )
    if not isinstance(target, ast.Name):
        return False
    qualified = _qualified_name(value, aliases)
    if qualified is None or aliases.get(target.id) == qualified:
        return False
    aliases[target.id] = qualified
    return True


def _apply_import(
    node: ast.Import | ast.ImportFrom,
    aliases: dict[str, str],
    module_name: str | None,
    *,
    is_package: bool = False,
) -> bool:
    changed = False
    if isinstance(node, ast.Import):
        for imported in node.names:
            local_name = imported.asname or imported.name.split(".")[0]
            qualified = imported.name if imported.asname else local_name
            if aliases.get(local_name) != qualified:
                aliases[local_name] = qualified
                changed = True
        return changed

    imported_module = _resolve_import_module(
        module_name,
        node.module,
        node.level,
        is_package=is_package,
    )
    for imported in node.names:
        if imported.name == "*":
            continue
        qualified = (
            f"{imported_module}.{imported.name}"
            if imported_module
            else imported.name
        )
        local_name = imported.asname or imported.name
        if aliases.get(local_name) != qualified:
            aliases[local_name] = qualified
            changed = True
    return changed


def _module_aliases(
    tree: ast.Module,
    module_name: str | None = None,
    *,
    is_package: bool = False,
) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            _apply_import(node, aliases, module_name, is_package=is_package)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            value = node.value
            if value is None:
                continue
            qualified = _qualified_name(value.func, aliases) if isinstance(value, ast.Call) else None
            if qualified == "fastapi.APIRouter":
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name):
                        aliases[target.id] = ROUTER_INSTANCE
                continue
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                _bind_alias(target, value, aliases)
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.NamedExpr):
            _bind_alias(node.value.target, node.value.value, aliases)
    return aliases


def _route_decorators(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    aliases: dict[str, str],
) -> list[tuple[str, str]]:
    routes: list[tuple[str, str]] = []
    direct_methods = {
        "get",
        "post",
        "put",
        "patch",
        "delete",
        "head",
        "options",
        "trace",
        "websocket",
        "websocket_route",
    }
    for decorator in function.decorator_list:
        if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
            continue
        if _qualified_name(decorator.func.value, aliases) != ROUTER_INSTANCE:
            continue
        method = decorator.func.attr.lower()
        if method not in direct_methods | {"api_route"}:
            continue
        path = (
            str(decorator.args[0].value)
            if decorator.args and isinstance(decorator.args[0], ast.Constant)
            else "<dynamic>"
        )
        if method != "api_route":
            routes.append((method, path))
            continue
        methods_node = next(
            (keyword.value for keyword in decorator.keywords if keyword.arg == "methods"),
            None,
        )
        if not isinstance(methods_node, (ast.List, ast.Tuple, ast.Set)):
            routes.append(("api_route", path))
            continue
        parsed_methods = [
            str(element.value).lower()
            for element in methods_node.elts
            if isinstance(element, ast.Constant) and isinstance(element.value, str)
        ]
        if len(parsed_methods) != len(methods_node.elts) or not parsed_methods:
            routes.append(("api_route", path))
            continue
        routes.extend((parsed_method, path) for parsed_method in parsed_methods)
    return routes


def _module_functions(
    tree: ast.Module,
) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _module_name_for_path(relative_path: str) -> str:
    parts = list(Path(relative_path).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


_FORBIDDEN_NAMESPACE_MODULES = {
    "services.storage",
    "services.storage_factory",
    "services.template_sync_locks",
    "services.project_template_revision",
}
_FORBIDDEN_SYMBOLS_BY_MODULE = {
    "services.student_pages": {"lock_student_page_writes"},
    "services.student_render_service": {"_lock_student_render"},
}
_FORBIDDEN_OWNER_MODULES = _FORBIDDEN_NAMESPACE_MODULES | set(
    _FORBIDDEN_SYMBOLS_BY_MODULE
)
_ALLOWED_STATIC_OPERATIONS = {
    ("routers/projects/render.py", "render_all_students", "transaction.rollback"): 1,
}
_DYNAMIC_RESOLUTION_NAMES = {
    "__import__",
    "__getattribute__",
    "eval",
    "exec",
    "getattr",
    "globals",
    "import_module",
    "importlib",
    "locals",
    "setattr",
}


def _forbidden_imports(
    tree: ast.Module,
    relative_path: str,
    module_name: str,
    *,
    is_package: bool,
) -> list[str]:
    errors: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for imported in node.names:
                if imported.name in _FORBIDDEN_OWNER_MODULES:
                    errors.append(
                        f"forbidden namespace import：backend/{relative_path}:{node.lineno} "
                        f"{imported.name}"
                    )
        elif isinstance(node, ast.ImportFrom):
            if any(imported.name == "*" for imported in node.names):
                errors.append(
                    f"router 禁止 wildcard import：backend/{relative_path}:{node.lineno}"
                )
                continue
            imported_module = _resolve_import_module(
                module_name,
                node.module,
                node.level,
                is_package=is_package,
            )
            if imported_module in _FORBIDDEN_NAMESPACE_MODULES:
                errors.append(
                    f"forbidden owner import：backend/{relative_path}:{node.lineno} "
                    f"{imported_module}"
                )
                continue
            if imported_module in _FORBIDDEN_SYMBOLS_BY_MODULE:
                forbidden_symbols = _FORBIDDEN_SYMBOLS_BY_MODULE[imported_module]
                for imported in node.names:
                    if imported.name in forbidden_symbols:
                        errors.append(
                            f"forbidden symbol import：backend/{relative_path}:{node.lineno} "
                            f"{imported_module}.{imported.name}"
                        )
            if imported_module == "services":
                for imported in node.names:
                    imported_namespace = f"services.{imported.name}"
                    if imported_namespace in _FORBIDDEN_OWNER_MODULES:
                        errors.append(
                            f"forbidden namespace re-export：backend/{relative_path}:"
                            f"{node.lineno} {imported_namespace}"
                        )
    return errors


def _raw_qualified_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _raw_qualified_name(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def _direct_function_scope_node_ids(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
) -> set[int]:
    """回傳 function 直接 scope 節點；nested helper／lambda／class body 不納入。"""
    node_ids: set[int] = set()

    def visit(node: ast.AST) -> None:
        node_ids.add(id(node))
        if isinstance(
            node,
            (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef),
        ):
            return
        for child in ast.iter_child_nodes(node):
            visit(child)

    for statement in function.body:
        visit(statement)
    return node_ids


def _is_exact_allowed_render_rollback(
    relative_path: str,
    function_name: str,
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    node: ast.Attribute,
    parents: dict[int, ast.AST],
    direct_scope_node_ids: set[int],
) -> bool:
    if relative_path != "routers/projects/render.py" or function_name != "render_all_students":
        return False
    parameter_names = {
        argument.arg
        for argument in [
            *function.args.posonlyargs,
            *function.args.args,
            *function.args.kwonlyargs,
        ]
    }
    if "db" not in parameter_names or id(node) not in direct_scope_node_ids:
        return False
    if node.attr != "rollback" or not isinstance(node.value, ast.Name) or node.value.id != "db":
        return False
    parent = parents.get(id(node))
    return (
        isinstance(parent, ast.Call)
        and parent.func is node
        and not parent.args
        and not parent.keywords
    )


def _dynamic_resolution_errors(tree: ast.Module, relative_path: str) -> list[str]:
    errors: list[str] = []
    for node in ast.walk(tree):
        reference: str | None = None
        if isinstance(node, ast.Name) and node.id in _DYNAMIC_RESOLUTION_NAMES:
            reference = node.id
        elif isinstance(node, ast.Attribute) and node.attr in _DYNAMIC_RESOLUTION_NAMES:
            reference = node.attr
        elif isinstance(node, ast.Import):
            imported_root = next(
                (
                    imported.name
                    for imported in node.names
                    if imported.name.split(".", 1)[0] in _DYNAMIC_RESOLUTION_NAMES
                ),
                None,
            )
            reference = imported_root
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.module.split(".", 1)[0] in _DYNAMIC_RESOLUTION_NAMES:
                reference = node.module
            else:
                reference = next(
                    (
                        imported.name
                        for imported in node.names
                        if imported.name in _DYNAMIC_RESOLUTION_NAMES
                    ),
                    None,
                )
        if reference:
            errors.append(
                f"router 禁止 dynamic resolution reference：backend/{relative_path}:"
                f"{node.lineno} {reference}"
            )
    return errors


def _static_operation_counts(
    tree: ast.Module,
    relative_path: str,
) -> Counter[tuple[str, str, str]]:
    counts: Counter[tuple[str, str, str]] = Counter()
    functions = _module_functions(tree)
    covered_attributes: set[int] = set()
    for function_name, function in functions.items():
        parents = {
            id(child): parent
            for parent in ast.walk(function)
            for child in ast.iter_child_nodes(parent)
        }
        direct_scope_node_ids = _direct_function_scope_node_ids(function)
        for node in ast.walk(function):
            if isinstance(node, ast.Attribute):
                covered_attributes.add(id(node))
                if node.attr in TRANSACTION_METHODS:
                    operation = f"transaction.{node.attr}"
                    if operation == "transaction.rollback" and not _is_exact_allowed_render_rollback(
                        relative_path,
                        function_name,
                        function,
                        node,
                        parents,
                        direct_scope_node_ids,
                    ):
                        operation = "transaction.rollback.invalid_receiver_or_scope"
                    counts[(relative_path, function_name, operation)] += 1
                raw_name = _raw_qualified_name(node)
                if raw_name in STORAGE_FACTORIES:
                    counts[(relative_path, function_name, "storage.get_storage")] += 1
                if raw_name in LOCK_SYMBOLS:
                    counts[(relative_path, function_name, LOCK_SYMBOLS[raw_name])] += 1
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and id(node) not in covered_attributes:
            if node.attr in TRANSACTION_METHODS:
                counts[(relative_path, "<module>", f"transaction.{node.attr}")] += 1
            raw_name = _raw_qualified_name(node)
            if raw_name in STORAGE_FACTORIES:
                counts[(relative_path, "<module>", "storage.get_storage")] += 1
            if raw_name in LOCK_SYMBOLS:
                counts[(relative_path, "<module>", LOCK_SYMBOLS[raw_name])] += 1
    return counts


def _static_boundary_errors(
    tree: ast.Module,
    relative_path: str,
    module_name: str,
    *,
    is_package: bool,
) -> list[str]:
    errors = _forbidden_imports(
        tree,
        relative_path,
        module_name,
        is_package=is_package,
    )
    errors.extend(_dynamic_resolution_errors(tree, relative_path))
    counts = _static_operation_counts(tree, relative_path)
    allowed_keys = {
        key for key in _ALLOWED_STATIC_OPERATIONS if key[0] == relative_path
    }
    keys = counts.keys() | allowed_keys
    for key in sorted(keys):
        actual = counts[key]
        expected = _ALLOWED_STATIC_OPERATIONS.get(key, 0)
        if actual != expected:
            errors.append(
                f"router static boundary 不符：backend/{key[0]}::{key[1]}::{key[2]} "
                f"expected={expected} actual={actual}"
            )
    return errors


def audit_routes() -> tuple[list[str], Counter[str]]:
    errors: list[str] = []
    debt: Counter[str] = Counter()
    actual_files = {
        path.relative_to(AUDITED_ROOT).as_posix()
        for path in (AUDITED_ROOT / "routers").rglob("*.py")
    }
    module_trees: dict[str, ast.Module] = {}
    module_aliases_by_path: dict[str, dict[str, str]] = {}
    for relative_path in actual_files:
        source_path = AUDITED_ROOT / relative_path
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        module_name = _module_name_for_path(relative_path)
        module_trees[relative_path] = tree
        module_aliases_by_path[relative_path] = _module_aliases(
            tree,
            module_name,
            is_package=Path(relative_path).name == "__init__.py",
        )
        errors.extend(
            _static_boundary_errors(
                tree,
                relative_path,
                module_name,
                is_package=Path(relative_path).name == "__init__.py",
            )
        )

    for relative_path, expected_specs in ROUTE_INVENTORY.items():
        source_path = AUDITED_ROOT / relative_path
        if not source_path.exists():
            errors.append(f"缺少 audited router：backend/{relative_path}")
            continue
        tree = module_trees[relative_path]
        module_aliases = module_aliases_by_path[relative_path]
        functions = _module_functions(tree)
        discovered: set[tuple[str, str, str]] = set()
        for function in functions.values():
            for method, path in _route_decorators(function, module_aliases):
                discovered.add((method, path, function.name))

        expected = {(spec.method, spec.path, spec.function) for spec in expected_specs}
        for route in sorted(discovered - expected):
            errors.append(f"未分類 route：backend/{relative_path} {route[0].upper()} {route[1]} ({route[2]})")
        for route in sorted(expected - discovered):
            errors.append(f"inventory route 不存在：backend/{relative_path} {route[0].upper()} {route[1]} ({route[2]})")

    expected_files = set(ROUTE_INVENTORY)
    if not expected_files <= actual_files:
        errors.append("audited router 檔案 inventory 與實際檔案不一致")

    # 掃完整 backend/routers tree；任何新根層/子目錄 route 檔都必須先進 inventory。
    for relative_path in sorted(actual_files - expected_files):
        tree = module_trees[relative_path]
        aliases = module_aliases_by_path[relative_path]
        has_routes = any(
            _route_decorators(node, aliases)
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        )
        if has_routes:
            errors.append(f"未分類 audited router 檔案：backend/{relative_path}")
    return errors, debt


def _format_counter(counter: Counter[str] | dict[str, int]) -> str:
    return "\n".join(f'    "{key}": {counter[key]},' for key in sorted(counter))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--show-current",
        action="store_true",
        help="輸出目前偵測到的 debt，供審核後更新 manifest；仍會驗 inventory。",
    )
    args = parser.parse_args()
    errors, current_debt = audit_routes()
    if args.show_current:
        if errors:
            print("\n".join(errors))
            return 1
        print(_format_counter(current_debt))
        return 0

    expected_debt = Counter(EXPECTED_DEBT)
    for key in sorted(current_debt.keys() | expected_debt.keys()):
        actual_count = current_debt[key]
        expected_count = expected_debt[key]
        if actual_count != expected_count:
            errors.append(
                f"route debt 不符：backend/{key} expected={expected_count} actual={actual_count}"
            )
    if errors:
        print("Backend route boundary gate failed:")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print(
        "Backend route boundary gate passed "
        f"({sum(len(routes) for routes in ROUTE_INVENTORY.values())} routes, "
        f"{sum(current_debt.values())} manifested debt calls)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
