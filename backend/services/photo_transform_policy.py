"""學生照片 transform 的跨 API／renderer 安全契約。"""

import json
from pathlib import Path


_DESIGN_TOKENS = json.loads(
    (Path(__file__).parent / "design_tokens.json").read_text(encoding="utf-8")
)
PHOTO_SCALE_MAX = float(_DESIGN_TOKENS["photo_transform"]["max_scale"])
