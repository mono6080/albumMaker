"""以 AST 稽核 audited routers 的 use-case 邊界與既有 debt。

新增或移除 route 必須同步更新 ROUTE_INVENTORY；尚未下移的禁止操作則必須逐 route、
逐操作種類精確列入 EXPECTED_DEBT。import alias 與單純的函式 alias 都會解析，避免改名繞過。
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
        ("post", "/", "create_project"),
        ("get", "/{project_id}", "get_project"),
        ("get", "/{project_id}/students/{student_id}/editor", "get_student_editor_detail"),
        ("patch", "/{project_id}", "rename_project"),
        ("delete", "/{project_id}", "delete_project"),
        ("post", "/{project_id}/restore", "restore_project"),
        ("post", "/{project_id}/complete", "complete_project"),
        ("post", "/{project_id}/reopen", "reopen_project"),
        ("post", "/{project_id}/students/batch", "batch_add_students"),
        ("post", "/{project_id}/students/copy", "copy_students_from_project"),
        ("put", "/{project_id}/students/{student_id}", "update_student"),
        ("delete", "/{project_id}/students/{student_id}", "delete_student"),
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
        ("get", "/semester-export", "get_semester_export_preview"),
        ("get", "/teacher-progress", "get_teacher_progress"),
        ("get", "/teacher-overview/export", "export_teacher_overview_excel"),
        ("put", "/students/{student_id}/link", "link_student_to_roster_child"),
        (
            "post",
            "/children/{child_id}/merge/{target_child_id}",
            "merge_roster_child_into",
        ),
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
}


# 格式："相對路徑::route function::操作種類": 精確呼叫次數。
# 只容納尚未下移的歷史 debt；新 use-case 不得加入這裡掩蓋回歸。
EXPECTED_DEBT: dict[str, int] = {
    "routers/projects/comments.py::add_comment::transaction.commit": 1,
    "routers/projects/comments.py::delete_comment::transaction.commit": 1,
    "routers/projects/crud.py::batch_add_students::lock.project": 1,
    "routers/projects/crud.py::batch_add_students::transaction.commit": 1,
    "routers/projects/crud.py::batch_add_students::transaction.rollback": 1,
    "routers/projects/crud.py::copy_students_from_project::lock.project": 1,
    "routers/projects/crud.py::copy_students_from_project::transaction.commit": 1,
    "routers/projects/crud.py::copy_students_from_project::transaction.rollback": 1,
    "routers/projects/crud.py::delete_student::lock.project": 1,
    "routers/projects/crud.py::delete_student::lock.student": 1,
    "routers/projects/crud.py::delete_student::storage.get_storage": 1,
    "routers/projects/crud.py::delete_student::transaction.commit": 1,
    "routers/projects/crud.py::delete_student::transaction.flush": 1,
    "routers/projects/crud.py::delete_student::transaction.rollback": 1,
    "routers/projects/crud.py::set_page_skip::lock.project_template_revision": 1,
    "routers/projects/crud.py::update_student::lock.project": 1,
    "routers/projects/crud.py::update_student::lock.student": 1,
    "routers/projects/crud.py::update_student::storage.get_storage": 1,
    "routers/projects/crud.py::update_student::transaction.commit": 1,
    "routers/projects/crud.py::update_student::transaction.flush": 1,
    "routers/projects/crud.py::update_student::transaction.rollback": 2,
    "routers/projects/photos.py::batch_upload_photos::lock.project_template_revision": 1,
    "routers/projects/photos.py::batch_upload_photos::storage.get_storage": 1,
    "routers/projects/photos.py::get_photo::storage.get_storage": 2,
    "routers/projects/photos.py::update_photo_mapping::lock.project_template_revision": 1,
    "routers/projects/photos.py::update_photo_mapping::storage.get_storage": 1,
    "routers/projects/photos.py::upload_photo::lock.project_template_revision": 1,
    "routers/projects/photos.py::upload_photo::storage.get_storage": 1,
    "routers/projects/photos.py::upload_shared_project_photo::lock.project_template_revision": 1,
    "routers/projects/photos.py::upload_shared_project_photo::storage.get_storage": 1,
    "routers/projects/render.py::download_student_pdf::storage.get_storage": 1,
    "routers/projects/texts.py::batch_update_texts::lock.project_template_revision": 1,
    "routers/projects/texts.py::batch_update_texts::transaction.commit": 1,
    "routers/projects/texts.py::update_project_label_texts::lock.project_template_revision": 1,
    "routers/projects/texts.py::update_project_label_texts::transaction.commit": 1,
    "routers/projects/texts.py::update_student_label_texts::lock.project_template_revision": 1,
    "routers/roster.py::link_student_to_roster_child::transaction.commit": 1,
    "routers/roster.py::link_student_to_roster_child::transaction.flush": 1,
    "routers/roster.py::merge_roster_child_into::transaction.commit": 1,
    "routers/templates/assets.py::get_background::storage.get_storage": 1,
    "routers/templates/assets.py::upload_background::lock.template": 1,
    "routers/templates/assets.py::upload_background::storage.get_storage": 1,
    "routers/templates/assets.py::upload_background::transaction.rollback": 2,
    "routers/templates/crud.py::create_template::transaction.commit": 1,
    "routers/templates/crud.py::create_template::transaction.flush": 1,
    "routers/templates/periods.py::create_template_period::transaction.commit": 1,
    "routers/templates/periods.py::update_template_period::transaction.commit": 1,
}

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
ALLOWED_BY_POLICY = {
    AUDITED: frozenset(),
    PREVIEW_CACHE: frozenset({"storage.get_storage"}),
    RENDER_ALL: frozenset({"transaction.rollback"}),
}


def _qualified_name(node: ast.AST, aliases: dict[str, str]) -> str | None:
    if isinstance(node, ast.Name):
        return aliases.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        base = _qualified_name(node.value, aliases)
        return f"{base}.{node.attr}" if base else None
    return None


def _is_aliasable_operation_symbol(qualified: str | None) -> bool:
    if not qualified:
        return False
    return (
        qualified in STORAGE_FACTORIES
        or qualified in LOCK_SYMBOLS
        or qualified.rsplit(".", 1)[-1] in TRANSACTION_METHODS
    )


def _module_aliases(tree: ast.Module) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module:
            for imported in node.names:
                aliases[imported.asname or imported.name] = f"{node.module}.{imported.name}"
        elif isinstance(node, ast.Import):
            for imported in node.names:
                local_name = imported.asname or imported.name.split(".")[0]
                aliases[local_name] = imported.name if imported.asname else local_name
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            value = node.value
            if value is None:
                continue
            if isinstance(value, ast.Call) and _qualified_name(value.func, aliases) == "fastapi.APIRouter":
                qualified = ROUTER_INSTANCE
            else:
                qualified = _qualified_name(value, aliases)
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Name) and qualified:
                    # 依 Python module 執行順序解析任意 namespace/function/router alias chain。
                    aliases[target.id] = qualified
    return aliases


def _route_aliases(function: ast.FunctionDef | ast.AsyncFunctionDef, base: dict[str, str]) -> dict[str, str]:
    aliases = dict(base)
    # 支援 route 內簡單 alias；Call、subscript 等動態賦值不猜測。
    changed = True
    while changed:
        changed = False
        for node in ast.walk(function):
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            value = node.value
            if value is None:
                continue
            qualified = _qualified_name(value, aliases)
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if (
                    isinstance(target, ast.Name)
                    and _is_aliasable_operation_symbol(qualified)
                    and aliases.get(target.id) != qualified
                ):
                    aliases[target.id] = qualified
                    changed = True
    return aliases


def _route_decorators(
    function: ast.FunctionDef | ast.AsyncFunctionDef,
    aliases: dict[str, str],
) -> list[tuple[str, str]]:
    routes: list[tuple[str, str]] = []
    for decorator in function.decorator_list:
        if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
            continue
        if _qualified_name(decorator.func.value, aliases) != ROUTER_INSTANCE:
            continue
        method = decorator.func.attr.lower()
        if method not in {"get", "post", "put", "patch", "delete"}:
            continue
        if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
            routes.append((method, "<dynamic>"))
            continue
        routes.append((method, str(decorator.args[0].value)))
    return routes


def _module_functions(
    tree: ast.Module,
) -> dict[str, ast.FunctionDef | ast.AsyncFunctionDef]:
    return {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _route_operations(
    route_function: ast.FunctionDef | ast.AsyncFunctionDef,
    module_aliases: dict[str, str],
    functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef],
) -> Counter[str]:
    """掃 route 與其直接/間接呼叫的同模組 helper，外部 service 不展開。"""
    operations: Counter[str] = Counter()
    pending = [route_function]
    visited: set[str] = set()
    while pending:
        function = pending.pop()
        if function.name in visited:
            continue
        visited.add(function.name)
        aliases = _route_aliases(function, module_aliases)
        for node in ast.walk(function):
            if not isinstance(node, ast.Call):
                continue
            operation = _operation(node, aliases)
            if operation:
                operations[operation] += 1
            called_name = _qualified_name(node.func, aliases)
            if called_name in functions and called_name not in visited:
                pending.append(functions[called_name])
    return operations


def _operation(call: ast.Call, aliases: dict[str, str]) -> str | None:
    if isinstance(call.func, ast.Attribute) and call.func.attr in TRANSACTION_METHODS:
        return f"transaction.{call.func.attr}"
    qualified = _qualified_name(call.func, aliases)
    if qualified and qualified.rsplit(".", 1)[-1] in TRANSACTION_METHODS:
        return f"transaction.{qualified.rsplit('.', 1)[-1]}"
    if qualified in STORAGE_FACTORIES:
        return "storage.get_storage"
    if qualified in LOCK_SYMBOLS:
        return LOCK_SYMBOLS[qualified]
    return None


def _debt_key(relative_path: str, function: str, operation: str) -> str:
    return f"{relative_path}::{function}::{operation}"


def audit_routes() -> tuple[list[str], Counter[str]]:
    errors: list[str] = []
    debt: Counter[str] = Counter()
    for relative_path, expected_specs in ROUTE_INVENTORY.items():
        source_path = AUDITED_ROOT / relative_path
        if not source_path.exists():
            errors.append(f"缺少 audited router：backend/{relative_path}")
            continue
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        module_aliases = _module_aliases(tree)
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

        for spec in expected_specs:
            function = functions.get(spec.function)
            if function is None:
                continue
            allowed = ALLOWED_BY_POLICY[spec.policy]
            for operation, count in _route_operations(function, module_aliases, functions).items():
                if operation not in allowed:
                    debt[_debt_key(relative_path, spec.function, operation)] += count

    expected_files = set(ROUTE_INVENTORY)
    actual_files = {
        path.relative_to(AUDITED_ROOT).as_posix()
        for path in (AUDITED_ROOT / "routers").rglob("*.py")
    }
    if not expected_files <= actual_files:
        errors.append("audited router 檔案 inventory 與實際檔案不一致")

    # 掃完整 backend/routers tree；任何新根層/子目錄 route 檔都必須先進 inventory。
    for relative_path in sorted(actual_files - expected_files):
        source_path = AUDITED_ROOT / relative_path
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        aliases = _module_aliases(tree)
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
