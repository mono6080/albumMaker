TEXT_ALIGN_VALUES = {"left", "center", "right"}


def normalize_text_align(value) -> str | None:
    return value if value in TEXT_ALIGN_VALUES else None


def label_entry_to_fields(entry) -> dict:
    if entry is None:
        return {}

    if isinstance(entry, dict):
        fields = {}
        if "text" in entry and entry.get("text") is not None:
            fields["text"] = str(entry.get("text"))
        text_align = normalize_text_align(entry.get("text_align"))
        if text_align:
            fields["text_align"] = text_align
        return fields

    return {"text": str(entry)}


def fields_to_label_entry(fields: dict, prefer_object: bool = False):
    if not fields:
        return None
    if not prefer_object and set(fields) == {"text"}:
        return fields["text"]
    return dict(fields)


def normalize_label_entry(entry):
    return fields_to_label_entry(label_entry_to_fields(entry), isinstance(entry, dict))


def get_label_entry_text(entry, default=None):
    fields = label_entry_to_fields(entry)
    return fields.get("text", default)


def get_label_entry_align(entry, default: str = "center") -> str:
    fields = label_entry_to_fields(entry)
    return fields.get("text_align") or default


def label_entry_has_style_override(entry) -> bool:
    return "text_align" in label_entry_to_fields(entry)


def merge_label_entries(base_entry, override_entry):
    base_fields = label_entry_to_fields(base_entry)
    override_fields = label_entry_to_fields(override_entry)
    merged_fields = {**base_fields, **override_fields}
    prefer_object = (
        isinstance(base_entry, dict)
        or isinstance(override_entry, dict)
        or "text_align" in merged_fields
    )
    return fields_to_label_entry(merged_fields, prefer_object)
