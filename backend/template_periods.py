"""模板期別的部門常數與狀態邏輯。

`TEMPLATE_DEPARTMENTS` 是部門代碼與顯示名稱的正本。跨語言鏡像：
`frontend/src/constants/departments.js`（前端另可經 `/api/templates/departments`
取得同一份清單）；兩邊一致由 `tests/test_contract_pins.py` 的
`test_department_labels_mirror_backend_source` 釘住。
"""

TEMPLATE_DEPARTMENTS = (
    {"code": "infant", "name": "嬰幼部"},
    {"code": "academy", "name": "學院部"},
)

TEMPLATE_DEPARTMENT_LABELS = {
    department["code"]: department["name"]
    for department in TEMPLATE_DEPARTMENTS
}

PERIOD_STATUS_LABELS = {
    "draft": "草稿",
    "active": "使用中",
    "archived": "已封存",
}

VALID_PERIOD_STATUSES = tuple(PERIOD_STATUS_LABELS.keys())
VALID_TEMPLATE_DEPARTMENTS = tuple(TEMPLATE_DEPARTMENT_LABELS.keys())

DEFAULT_TEMPLATE_PERIOD_NAME = "202605"
DEFAULT_TEMPLATE_PERIOD_DEPARTMENT = "infant"


def department_label(department: str | None) -> str | None:
    if department is None:
        return None
    return TEMPLATE_DEPARTMENT_LABELS.get(department, department)


def period_status_label(status: str | None) -> str | None:
    if status is None:
        return None
    return PERIOD_STATUS_LABELS.get(status, status)
