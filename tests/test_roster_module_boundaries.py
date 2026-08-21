"""名冊／學期服務的單向 module DAG 契約。"""

import ast
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1] / "backend"


def _service_imports(relative_path: str) -> set[str]:
    tree = ast.parse((BACKEND_ROOT / relative_path).read_text(encoding="utf-8"))
    imports = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imports.add(node.module)
        elif isinstance(node, ast.Import):
            imports.update(alias.name for alias in node.names)
    return imports


def test_roster_owner_modules_follow_one_way_dependency_graph():
    export_imports = _service_imports("services/semester_export_service.py")
    render_imports = _service_imports("services/semester_render_service.py")

    assert "services.roster_identity_service" not in export_imports
    assert "services.semester_export_service" in render_imports
    assert "services.semester_render_service" not in export_imports
