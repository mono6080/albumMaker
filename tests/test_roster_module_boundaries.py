"""名冊／學期服務的單向 module DAG 與相容 facade 契約。"""

import ast
from pathlib import Path

from services import (
    roster_identity_service,
    roster_service,
    semester_export_service,
    semester_render_service,
)


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


def test_roster_service_facade_reexports_true_owners():
    expected_owners = {
        "build_semester_export_preview": semester_export_service,
        "load_export_periods": semester_export_service,
        "load_export_projects": semester_export_service,
        "load_output_keys_by_project": semester_export_service,
        "normalize_child_name": roster_identity_service,
        "open_semester_export_zip_stream": semester_export_service,
        "render_missing_semester_albums": semester_render_service,
        "student_pdf_key": semester_export_service,
    }
    assert set(roster_service.__all__) == set(expected_owners)
    for symbol, owner in expected_owners.items():
        assert getattr(roster_service, symbol) is getattr(owner, symbol)


def test_roster_owner_modules_follow_one_way_dependency_graph():
    identity_imports = _service_imports("services/roster_identity_service.py")
    export_imports = _service_imports("services/semester_export_service.py")
    render_imports = _service_imports("services/semester_render_service.py")

    assert "services.roster_service" not in identity_imports | export_imports | render_imports
    assert "services.roster_identity_service" not in export_imports
    assert "services.semester_export_service" in render_imports
    assert "services.semester_render_service" not in export_imports

    internal_facade_consumers = []
    for source_path in BACKEND_ROOT.rglob("*.py"):
        if source_path.name == "roster_service.py":
            continue
        relative_path = source_path.relative_to(BACKEND_ROOT).as_posix()
        if "services.roster_service" in _service_imports(relative_path):
            internal_facade_consumers.append(relative_path)
    assert internal_facade_consumers == []
