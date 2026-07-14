"""Validation and deterministic traversal for flat world-coordinate groups.

Groups are structural root nodes only.  Their children keep living in the
existing ``text_labels`` and ``stickers`` collections and remain the sole
geometry authority.
"""

from __future__ import annotations

import logging
import math
from typing import Any, Iterator


logger = logging.getLogger(__name__)

GROUP_CONTRACT = "flat-world-v1"

_ELEMENT_SPECS = (
    ("photo_slots", "photo", 0, 0),
    ("text_bubbles", "bubble", 100, 1),
    ("text_labels", "text", 200, 2),
    ("stickers", "sticker", 300, 3),
)
_GROUP_RANK = 4
_GROUPABLE_COLLECTIONS = {"text": "text_labels", "sticker": "stickers"}
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
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and value.strip():
        return value
    raise ValueError("ID must be a non-empty string or finite integer")


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
        "group_id": group_id,
        "child_type": child_type,
        "child_id": child_id,
        "message": message,
    }


def _is_finite_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


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


def validate_layout_groups(layout: Any) -> list[dict[str, Any]]:
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
            if child_type not in _GROUPABLE_COLLECTIONS:
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
    if not groups:
        return legacy_nodes

    errors = validate_layout_groups(layout)
    if errors:
        if not malformed_fallback:
            raise LayoutGroupValidationError(errors)
        logger.warning(
            "malformed persisted layout groups; using legacy flat traversal errors=%s",
            errors,
        )
        return legacy_nodes

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
    for root in build_layout_render_tree(layout, malformed_fallback=malformed_fallback):
        if root["kind"] == "element":
            yield root["type"], root["data"], root["index"]
            continue
        for child in root["children"]:
            yield child["type"], child["data"], child["index"]
