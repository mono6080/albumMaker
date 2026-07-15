"""相容 facade；驗證與正式渲染 traversal 分別由專責模組持有。"""

from services.layout_group_traversal import (
    build_layout_render_tree,
    iter_layout_render_elements,
    layout_for_render_fingerprint,
)
from services.layout_group_validation import (
    GROUP_CONTRACT,
    MAX_JAVASCRIPT_SAFE_INTEGER,
    V1_GROUP_CONTRACT,
    V2_GROUP_CONTRACT,
    LayoutGroupValidationError,
    canonical_id,
    validate_layout_groups,
)


__all__ = [
    "GROUP_CONTRACT",
    "MAX_JAVASCRIPT_SAFE_INTEGER",
    "V1_GROUP_CONTRACT",
    "V2_GROUP_CONTRACT",
    "LayoutGroupValidationError",
    "build_layout_render_tree",
    "canonical_id",
    "iter_layout_render_elements",
    "layout_for_render_fingerprint",
    "validate_layout_groups",
]
