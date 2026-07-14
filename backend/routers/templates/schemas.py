from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr


class TemplatePageSnapshotItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: StrictInt | None = None
    client_id: StrictStr | None = Field(default=None, min_length=1, max_length=128)
    layout: dict[str, Any]


class TemplatePageSnapshotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_page_ids: list[StrictInt]
    expected_revision: StrictInt = Field(ge=1)
    confirm_project_sync: StrictBool = False
    project_sync_change_hash: StrictStr | None = Field(default=None, min_length=16, max_length=128)
    pages: list[TemplatePageSnapshotItem]
