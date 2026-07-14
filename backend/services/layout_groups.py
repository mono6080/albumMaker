"""Validation and deterministic traversal for world-coordinate groups.

``nested-world-v2`` is an arbitrary-depth forest over photo, bubble, text,
sticker, and group refs.  Leaves stay in their existing layout collections and
remain the sole geometry authority.  ``flat-world-v1`` keeps its original
one-level text/sticker validation and render compatibility for persisted data.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Iterator


logger = logging.getLogger(__name__)

MAX_JAVASCRIPT_SAFE_INTEGER = (1 << 53) - 1
V1_GROUP_CONTRACT = "flat-world-v1"
V2_GROUP_CONTRACT = "nested-world-v2"
_SUPPORTED_GROUP_CONTRACTS = (V1_GROUP_CONTRACT, V2_GROUP_CONTRACT)
# Backwards-compatible export used by the v1 implementation/tests.
GROUP_CONTRACT = V1_GROUP_CONTRACT

_ELEMENT_SPECS = (
    ("photo_slots", "photo", 0, 0),
    ("text_bubbles", "bubble", 100, 1),
    ("text_labels", "text", 200, 2),
    ("stickers", "sticker", 300, 3),
)
_GROUP_RANK = 4
_GROUPABLE_COLLECTIONS = {"text": "text_labels", "sticker": "stickers"}
_V2_GROUPABLE_COLLECTIONS = {
    element_type: collection_name
    for collection_name, element_type, _, _ in _ELEMENT_SPECS
}
_FORBIDDEN_GROUP_GEOMETRY = {
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "bounds",
    "scale",
    "matrix",
    "transform",
}


class LayoutGroupValidationError(ValueError):
    """Raised when a caller explicitly requests strict group traversal."""

    def __init__(self, errors: list[dict[str, Any]]):
        super().__init__("invalid layout group contract")
        self.errors = errors


def canonical_id(value: Any) -> str:
    """Return the contract ID representation or raise ``ValueError``."""
    if isinstance(value, bool):
        raise ValueError("ID cannot be boolean")
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            if not math.isfinite(value) or not value.is_integer():
                raise ValueError("ID must be a non-empty string or finite integer")
            value = int(value)
        if not -MAX_JAVASCRIPT_SAFE_INTEGER <= value <= MAX_JAVASCRIPT_SAFE_INTEGER:
            raise ValueError("ID integer must be within JavaScript safe integer range")
        return str(value)
    if isinstance(value, str) and value.strip():
        return value
    raise ValueError("ID must be a non-empty string or finite integer")


def _json_safe_diagnostic(value: Any) -> Any:
    """Keep validation diagnostics serializable by Starlette's strict JSON encoder."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        if math.isnan(value):
            return "NaN"
        return "Infinity" if value > 0 else "-Infinity"
    if isinstance(value, (list, tuple)):
        return [_json_safe_diagnostic(item) for item in value]
    if isinstance(value, dict):
        return {
            key if isinstance(key, str) else str(key): _json_safe_diagnostic(item)
            for key, item in value.items()
        }
    return f"<{type(value).__name__}>"


def _error(
    path: str,
    message: str,
    *,
    group_id: Any = None,
    child_type: Any = None,
    child_id: Any = None,
) -> dict[str, Any]:
    return {
        "path": path,
        "group_id": _json_safe_diagnostic(group_id),
        "child_type": _json_safe_diagnostic(child_type),
        "child_id": _json_safe_diagnostic(child_id),
        "message": message,
    }


def _is_finite_number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _collect_groupable_elements(
    layout: dict,
    errors: list[dict[str, Any]],
) -> dict[str, dict[str, dict]]:
    elements: dict[str, dict[str, dict]] = {"text": {}, "sticker": {}}
    for child_type, collection_name in _GROUPABLE_COLLECTIONS.items():
        collection = layout.get(collection_name, [])
        if not isinstance(collection, list):
            errors.append(_error(collection_name, "collection must be an array"))
            continue
        for index, item in enumerate(collection):
            path = f"{collection_name}[{index}]"
            if not isinstance(item, dict):
                errors.append(_error(path, "element must be an object", child_type=child_type))
                continue
            raw_id = item.get("id")
            try:
                normalized_id = canonical_id(raw_id)
            except ValueError as exc:
                errors.append(
                    _error(f"{path}.id", str(exc), child_type=child_type, child_id=raw_id)
                )
                continue
            if normalized_id in elements[child_type]:
                errors.append(
                    _error(
                        f"{path}.id",
                        "element ID collides after string normalization",
                        child_type=child_type,
                        child_id=raw_id,
                    )
                )
                continue
            elements[child_type][normalized_id] = item
    return elements


def _validate_v1_layout_groups(layout: Any) -> list[dict[str, Any]]:
    """Validate the v1 group contract without mutating ``layout``.

    Layouts without groups retain legacy behavior and are deliberately not
    subjected to new element-ID requirements.
    """
    if not isinstance(layout, dict):
        return [_error("$", "layout must be an object")]

    groups = layout.get("groups")
    if groups is None:
        return []
    if not isinstance(groups, list):
        return [_error("groups", "groups must be an array")]
    if not groups:
        return []

    errors: list[dict[str, Any]] = []
    if layout.get("group_contract") != GROUP_CONTRACT:
        errors.append(
            _error("group_contract", f"group_contract must be {GROUP_CONTRACT!r}")
        )

    elements = _collect_groupable_elements(layout, errors)
    seen_group_ids: set[str] = set()
    memberships: dict[str, Any] = {}

    for group_index, group in enumerate(groups):
        group_path = f"groups[{group_index}]"
        if not isinstance(group, dict):
            errors.append(_error(group_path, "group must be an object"))
            continue

        raw_group_id = group.get("id")
        try:
            normalized_group_id = canonical_id(raw_group_id)
        except ValueError as exc:
            errors.append(_error(f"{group_path}.id", str(exc), group_id=raw_group_id))
            normalized_group_id = None
        if normalized_group_id is not None:
            if normalized_group_id in seen_group_ids:
                errors.append(
                    _error(
                        f"{group_path}.id",
                        "group ID collides after string normalization",
                        group_id=raw_group_id,
                    )
                )
            else:
                seen_group_ids.add(normalized_group_id)

        for forbidden_key in sorted(_FORBIDDEN_GROUP_GEOMETRY.intersection(group)):
            errors.append(
                _error(
                    f"{group_path}.{forbidden_key}",
                    "group geometry must be derived from children",
                    group_id=raw_group_id,
                )
            )

        if not _is_finite_number(group.get("z_index")):
            errors.append(
                _error(
                    f"{group_path}.z_index",
                    "z_index must be a finite number",
                    group_id=raw_group_id,
                )
            )
        if not _is_finite_number(group.get("selection_rotation")):
            errors.append(
                _error(
                    f"{group_path}.selection_rotation",
                    "selection_rotation must be a finite number",
                    group_id=raw_group_id,
                )
            )

        children = group.get("children")
        if not isinstance(children, list):
            errors.append(
                _error(f"{group_path}.children", "children must be an array", group_id=raw_group_id)
            )
            children = []
        elif len(children) < 2:
            errors.append(
                _error(
                    f"{group_path}.children",
                    "group must contain at least two children",
                    group_id=raw_group_id,
                )
            )

        group_child_keys: set[str] = set()
        child_types_by_id: dict[str, set[str]] = {"text": set(), "sticker": set()}
        for child_index, child in enumerate(children):
            child_path = f"{group_path}.children[{child_index}]"
            if not isinstance(child, dict):
                errors.append(
                    _error(child_path, "child ref must be an object", group_id=raw_group_id)
                )
                continue
            child_type = child.get("type")
            raw_child_id = child.get("id")
            if not isinstance(child_type, str) or child_type not in _GROUPABLE_COLLECTIONS:
                errors.append(
                    _error(
                        f"{child_path}.type",
                        "child type must be 'text' or 'sticker'",
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
                continue
            try:
                normalized_child_id = canonical_id(raw_child_id)
            except ValueError as exc:
                errors.append(
                    _error(
                        f"{child_path}.id",
                        str(exc),
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
                continue

            canonical_key = f"{child_type}:{normalized_child_id}"
            if canonical_key in group_child_keys:
                errors.append(
                    _error(
                        child_path,
                        "duplicate child ref in group",
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
                continue
            group_child_keys.add(canonical_key)
            child_types_by_id[child_type].add(normalized_child_id)

            if normalized_child_id not in elements[child_type]:
                errors.append(
                    _error(
                        child_path,
                        "child ref does not exist",
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
            if canonical_key in memberships:
                errors.append(
                    _error(
                        child_path,
                        "child already belongs to another group",
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
            else:
                memberships[canonical_key] = raw_group_id

        links = group.get("links", [])
        if not isinstance(links, list):
            errors.append(
                _error(f"{group_path}.links", "links must be an array", group_id=raw_group_id)
            )
            links = []
        linked_materials: set[str] = set()
        linked_texts: set[str] = set()
        for link_index, link in enumerate(links):
            link_path = f"{group_path}.links[{link_index}]"
            if not isinstance(link, dict):
                errors.append(_error(link_path, "link must be an object", group_id=raw_group_id))
                continue
            if link.get("kind") != "material-text-v1":
                errors.append(
                    _error(
                        f"{link_path}.kind",
                        "link kind must be 'material-text-v1'",
                        group_id=raw_group_id,
                    )
                )
            for endpoint_key, endpoint_type, linked_ids in (
                ("material_id", "sticker", linked_materials),
                ("text_id", "text", linked_texts),
            ):
                raw_endpoint_id = link.get(endpoint_key)
                try:
                    endpoint_id = canonical_id(raw_endpoint_id)
                except ValueError as exc:
                    errors.append(
                        _error(
                            f"{link_path}.{endpoint_key}",
                            str(exc),
                            group_id=raw_group_id,
                            child_type=endpoint_type,
                            child_id=raw_endpoint_id,
                        )
                    )
                    continue
                if endpoint_id not in child_types_by_id[endpoint_type]:
                    errors.append(
                        _error(
                            f"{link_path}.{endpoint_key}",
                            "link endpoint must reference a child in the same group",
                            group_id=raw_group_id,
                            child_type=endpoint_type,
                            child_id=raw_endpoint_id,
                        )
                    )
                if endpoint_id in linked_ids:
                    errors.append(
                        _error(
                            f"{link_path}.{endpoint_key}",
                            "link endpoint is already linked",
                            group_id=raw_group_id,
                            child_type=endpoint_type,
                            child_id=raw_endpoint_id,
                        )
                    )
                else:
                    linked_ids.add(endpoint_id)

    return errors


def _collect_v2_elements(
    layout: dict,
    errors: list[dict[str, Any]],
) -> dict[str, dict[str, dict]]:
    """Index all v2 leaf collections while reporting schema/ID errors."""
    elements: dict[str, dict[str, dict]] = {
        element_type: {} for element_type in _V2_GROUPABLE_COLLECTIONS
    }
    for collection_name, element_type, _, _ in _ELEMENT_SPECS:
        collection = layout.get(collection_name, [])
        if not isinstance(collection, list):
            errors.append(_error(collection_name, "collection must be an array"))
            continue
        for index, item in enumerate(collection):
            path = f"{collection_name}[{index}]"
            if not isinstance(item, dict):
                errors.append(_error(path, "element must be an object", child_type=element_type))
                continue
            raw_id = item.get("id")
            try:
                normalized_id = canonical_id(raw_id)
            except ValueError as exc:
                errors.append(
                    _error(f"{path}.id", str(exc), child_type=element_type, child_id=raw_id)
                )
                continue
            if normalized_id in elements[element_type]:
                errors.append(
                    _error(
                        f"{path}.id",
                        "element ID collides after string normalization",
                        child_type=element_type,
                        child_id=raw_id,
                    )
                )
                continue
            elements[element_type][normalized_id] = item
    return elements


def _validate_v2_layout_groups(
    layout: dict,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, dict]]]:
    """Validate the nested v2 topology without recursion."""
    errors: list[dict[str, Any]] = []
    elements = _collect_v2_elements(layout, errors)
    raw_groups = layout.get("groups")
    if raw_groups is None:
        groups: list[Any] = []
    elif not isinstance(raw_groups, list):
        errors.append(_error("groups", "groups must be an array"))
        groups = []
    else:
        groups = raw_groups

    group_entries: list[dict[str, Any]] = []
    groups_by_id: dict[str, dict] = {}
    group_order: list[str] = []

    # First pass registers every group so refs may point forward in registry order.
    for group_index, group in enumerate(groups):
        group_path = f"groups[{group_index}]"
        if not isinstance(group, dict):
            errors.append(_error(group_path, "group must be an object"))
            continue

        raw_group_id = group.get("id")
        normalized_group_id: str | None = None
        is_primary = False
        try:
            normalized_group_id = canonical_id(raw_group_id)
        except ValueError as exc:
            errors.append(_error(f"{group_path}.id", str(exc), group_id=raw_group_id))
        else:
            if normalized_group_id in groups_by_id:
                errors.append(
                    _error(
                        f"{group_path}.id",
                        "group ID collides after string normalization",
                        group_id=raw_group_id,
                    )
                )
            else:
                groups_by_id[normalized_group_id] = group
                group_order.append(normalized_group_id)
                is_primary = True

        for forbidden_key in sorted(_FORBIDDEN_GROUP_GEOMETRY.intersection(group)):
            errors.append(
                _error(
                    f"{group_path}.{forbidden_key}",
                    "group geometry must be derived from children",
                    group_id=raw_group_id,
                )
            )
        if "links" in group:
            errors.append(
                _error(
                    f"{group_path}.links",
                    "v2 links must be stored in material_text_links",
                    group_id=raw_group_id,
                )
            )
        if not _is_finite_number(group.get("z_index")):
            errors.append(
                _error(
                    f"{group_path}.z_index",
                    "z_index must be a finite number",
                    group_id=raw_group_id,
                )
            )
        if not _is_finite_number(group.get("selection_rotation")):
            errors.append(
                _error(
                    f"{group_path}.selection_rotation",
                    "selection_rotation must be a finite number",
                    group_id=raw_group_id,
                )
            )

        children = group.get("children")
        if not isinstance(children, list):
            errors.append(
                _error(f"{group_path}.children", "children must be an array", group_id=raw_group_id)
            )
            children = []
        elif len(children) < 2:
            errors.append(
                _error(
                    f"{group_path}.children",
                    "group must contain at least two children",
                    group_id=raw_group_id,
                )
            )
        group_entries.append(
            {
                "index": group_index,
                "path": group_path,
                "group": group,
                "id": normalized_group_id,
                "primary": is_primary,
                "children": children,
            }
        )

    memberships: dict[str, Any] = {}
    adjacency: dict[str, list[tuple[str, str, Any]]] = {
        group_id: [] for group_id in group_order
    }
    allowed_types = set(_V2_GROUPABLE_COLLECTIONS) | {"group"}

    # Second pass validates refs and compiles group-only adjacency for cycle checks.
    for entry in group_entries:
        group = entry["group"]
        raw_group_id = group.get("id")
        normalized_group_id = entry["id"]
        local_memberships: set[str] = set()
        for child_index, child in enumerate(entry["children"]):
            child_path = f"{entry['path']}.children[{child_index}]"
            if not isinstance(child, dict):
                errors.append(
                    _error(child_path, "child ref must be an object", group_id=raw_group_id)
                )
                continue
            child_type = child.get("type")
            raw_child_id = child.get("id")
            if not isinstance(child_type, str) or child_type not in allowed_types:
                errors.append(
                    _error(
                        f"{child_path}.type",
                        "child type must be photo, bubble, text, sticker, or group",
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
                continue
            try:
                normalized_child_id = canonical_id(raw_child_id)
            except ValueError as exc:
                errors.append(
                    _error(
                        f"{child_path}.id",
                        str(exc),
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
                continue

            canonical_key = f"{child_type}:{normalized_child_id}"
            if canonical_key in local_memberships:
                errors.append(
                    _error(
                        child_path,
                        "duplicate child ref in group",
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
                continue
            local_memberships.add(canonical_key)

            if child_type == "group":
                child_exists = normalized_child_id in groups_by_id
                if not child_exists:
                    errors.append(
                        _error(
                            child_path,
                            "child ref does not exist",
                            group_id=raw_group_id,
                            child_type=child_type,
                            child_id=raw_child_id,
                        )
                    )
                is_self = (
                    normalized_group_id is not None
                    and normalized_child_id == normalized_group_id
                )
                if is_self:
                    errors.append(
                        _error(
                            child_path,
                            "group cannot reference itself",
                            group_id=raw_group_id,
                            child_type=child_type,
                            child_id=raw_child_id,
                        )
                    )
                elif entry["primary"] and child_exists:
                    adjacency[normalized_group_id].append(
                        (normalized_child_id, child_path, raw_child_id)
                    )
            elif normalized_child_id not in elements[child_type]:
                errors.append(
                    _error(
                        child_path,
                        "child ref does not exist",
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )

            if canonical_key in memberships:
                errors.append(
                    _error(
                        child_path,
                        "child already belongs to another group",
                        group_id=raw_group_id,
                        child_type=child_type,
                        child_id=raw_child_id,
                    )
                )
            else:
                memberships[canonical_key] = raw_group_id

    # Iterative tri-colour DFS: a visiting child is the exact back-edge path.
    colors = {group_id: 0 for group_id in group_order}
    for start_group_id in group_order:
        if colors[start_group_id] != 0:
            continue
        colors[start_group_id] = 1
        stack: list[tuple[str, int]] = [(start_group_id, 0)]
        while stack:
            group_id, edge_index = stack[-1]
            edges = adjacency[group_id]
            if edge_index >= len(edges):
                colors[group_id] = 2
                stack.pop()
                continue
            child_group_id, child_path, raw_child_id = edges[edge_index]
            stack[-1] = (group_id, edge_index + 1)
            if colors[child_group_id] == 0:
                colors[child_group_id] = 1
                stack.append((child_group_id, 0))
            elif colors[child_group_id] == 1:
                errors.append(
                    _error(
                        child_path,
                        "group graph contains a cycle",
                        group_id=groups_by_id[group_id].get("id"),
                        child_type="group",
                        child_id=raw_child_id,
                    )
                )

    return errors, elements


def _index_link_elements(layout: dict) -> dict[str, dict[str, dict]]:
    """Best-effort endpoint index; schema errors are owned by topology validators."""
    elements: dict[str, dict[str, dict]] = {"text": {}, "sticker": {}}
    for element_type, collection_name in _GROUPABLE_COLLECTIONS.items():
        collection = layout.get(collection_name, [])
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict):
                continue
            try:
                normalized_id = canonical_id(item.get("id"))
            except ValueError:
                continue
            elements[element_type].setdefault(normalized_id, item)
    return elements


def _validate_top_level_links(layout: dict) -> list[dict[str, Any]]:
    raw_links = layout.get("material_text_links")
    if raw_links is None:
        return []
    if not isinstance(raw_links, list):
        return [_error("material_text_links", "material_text_links must be an array")]
    if not raw_links:
        return []

    errors: list[dict[str, Any]] = []
    if layout.get("group_contract") != V2_GROUP_CONTRACT:
        errors.append(
            _error(
                "group_contract",
                f"top-level material_text_links require {V2_GROUP_CONTRACT!r}",
            )
        )
    elements = _index_link_elements(layout)
    linked_materials: set[str] = set()
    linked_texts: set[str] = set()
    for link_index, link in enumerate(raw_links):
        link_path = f"material_text_links[{link_index}]"
        if not isinstance(link, dict):
            errors.append(_error(link_path, "link must be an object"))
            continue
        if link.get("kind") != "material-text-v1":
            errors.append(
                _error(f"{link_path}.kind", "link kind must be 'material-text-v1'")
            )
        for endpoint_key, endpoint_type, linked_ids in (
            ("material_id", "sticker", linked_materials),
            ("text_id", "text", linked_texts),
        ):
            raw_endpoint_id = link.get(endpoint_key)
            try:
                endpoint_id = canonical_id(raw_endpoint_id)
            except ValueError as exc:
                errors.append(
                    _error(
                        f"{link_path}.{endpoint_key}",
                        str(exc),
                        child_type=endpoint_type,
                        child_id=raw_endpoint_id,
                    )
                )
                continue
            if endpoint_id not in elements[endpoint_type]:
                errors.append(
                    _error(
                        f"{link_path}.{endpoint_key}",
                        "link endpoint does not exist",
                        child_type=endpoint_type,
                        child_id=raw_endpoint_id,
                    )
                )
            if endpoint_id in linked_ids:
                errors.append(
                    _error(
                        f"{link_path}.{endpoint_key}",
                        "link endpoint is already linked",
                        child_type=endpoint_type,
                        child_id=raw_endpoint_id,
                    )
                )
            else:
                linked_ids.add(endpoint_id)
    return errors


def _validate_layout_group_partitions(
    layout: Any,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return pixel-affecting topology errors separately from link-only errors."""
    if not isinstance(layout, dict):
        return [_error("$", "layout must be an object")], []

    contract = layout.get("group_contract")
    unsupported_contract = (
        contract is not None and contract not in _SUPPORTED_GROUP_CONTRACTS
    )
    groups = layout.get("groups")
    links = layout.get("material_text_links")
    groups_nonempty = isinstance(groups, list) and bool(groups)
    links_nonempty = isinstance(links, list) and bool(links)
    groups_malformed = groups is not None and not isinstance(groups, list)

    if contract == V2_GROUP_CONTRACT and (
        groups_nonempty or links_nonempty or groups_malformed
    ):
        topology_errors, _ = _validate_v2_layout_groups(layout)
    elif groups is not None:
        # This is the original v1 validator verbatim, including its empty-array
        # and malformed group-local-link read semantics.
        topology_errors = _validate_v1_layout_groups(layout)
    else:
        topology_errors = []

    link_errors = _validate_top_level_links(layout)
    if unsupported_contract:
        # Unknown markers are invalid even on an otherwise empty legacy page.
        # Replace v1/top-link-specific contract errors with one deterministic
        # contract error while retaining all unrelated diagnostics.
        topology_errors = [
            error for error in topology_errors if error["path"] != "group_contract"
        ]
        link_errors = [
            error for error in link_errors if error["path"] != "group_contract"
        ]
        topology_errors.insert(
            0,
            _error(
                "group_contract",
                f"group_contract must be {V1_GROUP_CONTRACT!r} or {V2_GROUP_CONTRACT!r}",
            ),
        )

    return topology_errors, link_errors


def validate_layout_groups(layout: Any) -> list[dict[str, Any]]:
    """Validate v1/v2 topology and material links without mutating layout."""
    topology_errors, link_errors = _validate_layout_group_partitions(layout)
    return [*topology_errors, *link_errors]


def _effective_z(value: Any, default: float) -> float:
    return float(value) if _is_finite_number(value) else float(default)


def _legacy_element_nodes(layout: dict) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for collection_name, element_type, default_base, type_rank in _ELEMENT_SPECS:
        collection = layout.get(collection_name, [])
        if not isinstance(collection, list):
            continue
        for index, data in enumerate(collection):
            if not isinstance(data, dict):
                continue
            nodes.append(
                {
                    "kind": "element",
                    "type": element_type,
                    "data": data,
                    "index": index,
                    "group_id": None,
                    "_sort": (
                        _effective_z(data.get("z_index"), default_base + index),
                        type_rank,
                        index,
                    ),
                }
            )
    nodes.sort(key=lambda node: node["_sort"])
    return nodes


def _build_v2_render_tree(
    layout: dict,
    legacy_nodes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Compile a validated flat v2 registry into a nested tree iteratively."""
    groups = layout.get("groups") or []
    elements_by_key = {
        f"{node['type']}:{canonical_id(node['data']['id'])}": node
        for node in legacy_nodes
    }
    groups_by_id = {canonical_id(group["id"]): group for group in groups}
    group_nodes: dict[str, dict[str, Any]] = {}
    for group_index, group in enumerate(groups):
        group_id = canonical_id(group["id"])
        group_nodes[group_id] = {
            "kind": "group",
            "group": group,
            "group_id": group["id"],
            "group_index": group_index,
            "children": [],
            "_sort": (
                _effective_z(group.get("z_index"), group_index),
                _GROUP_RANK,
                group_index,
            ),
        }

    parented_keys: set[str] = set()
    for group in groups:
        parent_node = group_nodes[canonical_id(group["id"])]
        children: list[dict[str, Any]] = []
        for child in group["children"]:
            normalized_child_id = canonical_id(child["id"])
            key = f"{child['type']}:{normalized_child_id}"
            parented_keys.add(key)
            if child["type"] == "group":
                children.append(group_nodes[normalized_child_id])
            else:
                children.append(
                    {
                        **elements_by_key[key],
                        "group_id": group["id"],
                    }
                )
        parent_node["children"] = children

    root_nodes = [
        node
        for node in legacy_nodes
        if f"{node['type']}:{canonical_id(node['data']['id'])}" not in parented_keys
    ]
    root_nodes.extend(
        group_nodes[group_id]
        for group_id in groups_by_id
        if f"group:{group_id}" not in parented_keys
    )
    root_nodes.sort(key=lambda node: node["_sort"])
    return root_nodes


def build_layout_render_tree(
    layout: dict,
    *,
    malformed_fallback: bool = True,
) -> list[dict[str, Any]]:
    """Build root nodes with grouped children expanded exactly once.

    Persisted malformed group data is handled as a whole-page legacy fallback;
    this prevents partial membership from either duplicating or dropping pixels.
    """
    legacy_nodes = _legacy_element_nodes(layout)
    groups = layout.get("groups")
    topology_errors, link_errors = _validate_layout_group_partitions(layout)
    if link_errors:
        logger.warning(
            "malformed persisted material_text_links; ignoring links errors=%s",
            link_errors,
        )
    if topology_errors:
        if not malformed_fallback:
            raise LayoutGroupValidationError(topology_errors)
        logger.warning(
            "malformed persisted layout groups; using legacy flat traversal errors=%s",
            topology_errors,
        )
        return legacy_nodes
    if not groups:
        return legacy_nodes

    if layout.get("group_contract") == V2_GROUP_CONTRACT:
        return _build_v2_render_tree(layout, legacy_nodes)

    grouped_keys: set[str] = set()
    group_nodes: list[dict[str, Any]] = []
    elements_by_key = {
        f"{node['type']}:{canonical_id(node['data']['id'])}": node
        for node in legacy_nodes
        if node["type"] in _GROUPABLE_COLLECTIONS
    }
    for group_index, group in enumerate(groups):
        children: list[dict[str, Any]] = []
        for child in group["children"]:
            key = f"{child['type']}:{canonical_id(child['id'])}"
            grouped_keys.add(key)
            source = elements_by_key[key]
            children.append(
                {
                    **source,
                    "group_id": group["id"],
                }
            )
        group_nodes.append(
            {
                "kind": "group",
                "group": group,
                "group_id": group["id"],
                "group_index": group_index,
                "children": children,
                "_sort": (
                    _effective_z(group.get("z_index"), group_index),
                    _GROUP_RANK,
                    group_index,
                ),
            }
        )

    root_nodes = [
        node
        for node in legacy_nodes
        if node["type"] not in _GROUPABLE_COLLECTIONS
        or f"{node['type']}:{canonical_id(node['data']['id'])}" not in grouped_keys
    ]
    root_nodes.extend(group_nodes)
    root_nodes.sort(key=lambda node: node["_sort"])
    return root_nodes


def iter_layout_render_elements(
    layout: dict,
    *,
    malformed_fallback: bool = True,
) -> Iterator[tuple[str, dict, int]]:
    """Yield ``(type, data, original_index)`` in final pixel traversal order."""
    stack = list(reversed(build_layout_render_tree(layout, malformed_fallback=malformed_fallback)))
    while stack:
        node = stack.pop()
        if node["kind"] == "element":
            yield node["type"], node["data"], node["index"]
            continue
        stack.extend(reversed(node["children"]))
