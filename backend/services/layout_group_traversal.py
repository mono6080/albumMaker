"""Deterministic render traversal for validated world-coordinate groups."""

from __future__ import annotations

import logging
from copy import deepcopy
from typing import Any, Iterator

from services.layout_group_validation import (
    V2_GROUP_CONTRACT,
    LayoutGroupValidationError,
    _ELEMENT_SPECS,
    _GROUPABLE_COLLECTIONS,
    _is_finite_number,
    _validate_layout_group_partitions,
    canonical_id,
)


logger = logging.getLogger(__name__)

_GROUP_RANK = 4
_EDITOR_ONLY_LAYOUT_KEYS = {"layer_name", "locked"}


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
            if node["data"].get("visible") is not False:
                yield node["type"], node["data"], node["index"]
            continue
        if node["group"].get("visible") is False:
            continue
        stack.extend(reversed(node["children"]))


def layout_for_render_fingerprint(layout: dict) -> dict:
    """移除不影響像素的編輯器 metadata，避免改名／鎖定觸發重渲。"""
    normalized_layout = deepcopy(layout)
    normalized_layout.pop("material_text_links", None)
    for collection_name in ("photo_slots", "text_labels", "stickers", "groups"):
        collection = normalized_layout.get(collection_name)
        if not isinstance(collection, list):
            continue
        for item in collection:
            if not isinstance(item, dict):
                continue
            for key in _EDITOR_ONLY_LAYOUT_KEYS:
                item.pop(key, None)
            if collection_name == "groups":
                item.pop("links", None)
    if not normalized_layout.get("groups"):
        normalized_layout.pop("group_contract", None)
    return normalized_layout
