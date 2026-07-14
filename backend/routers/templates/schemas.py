from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr


class TemplatePageSnapshotItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: StrictInt | None = None
    client_id: StrictStr | None = Field(default=None, min_length=1, max_length=128)
    layout: dict[str, Any]


class TemplatePageSnapshotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_page_ids: list[StrictInt]
    pages: list[TemplatePageSnapshotItem]
