# 繞道禁令檢查：有唯一入口的操作，禁止在入口以外的地方重新出現。
# 每條規則 =（正則, 允許出現的檔案, 為什麼）。新增入口時把檔案加進 allowed。
# 用法：python scripts/check_banned_patterns.py（CI 與本地驗證流程都會跑）

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent

# (pattern, allowed 相對路徑集合, 理由)
RULES = [
    (
        re.compile(r"\.pages_data_json\s*=[^=]"),
        # 模板同步已同時持有 template→project→student locks，必須在單一 transaction
        # 直接重排所有學生；學生搬移同理（見下）；兩個測試檔則刻意種入舊版／損壞
        # JSON 驗證復原路徑。
        #
        # student_transfer_service 不能用 mutate_student_pages()——它會在自己的鎖裡
        # commit，而搬移必須讓「改照片路徑、改 project_id、清輸出」一起成功。它改成
        # 明確持有 lock_student_page_writes(要搬的學生) 再寫，鎖的保證與唯一入口相同。
        {
            "backend/services/student_pages.py",
            "backend/services/template_project_sync_service.py",
            "backend/services/student_transfer_service.py",
            "tests/test_api_edges.py",
            "tests/test_template_project_sync.py",
        },
        "pages_data_json 是 read-modify-write，寫入必須走 mutate_student_pages()（學生寫鎖），"
        "繞過會重現照片/文字互相蓋寫的併發 bug",
    ),
    (
        re.compile(r"while len\(pages_data\)"),
        {"backend/services/student_pages.py"},
        "補頁樣板（空頁 schema）只能住 ensure_page_entry()，散開會回到五份複本的狀態",
    ),
    (
        re.compile(r'\[:-4\] \+ "_screen\.pdf"'),
        {"backend/services/project_service.py"},
        "screen PDF key 推導只能住 student_pdf_key_for_mode()",
    ),
    (
        re.compile(r'createElement\("a"\)'),
        {"frontend/src/utils/browserFiles.js"},
        "下載 anchor 只能住 browserFiles（downloadBlob / triggerNativeDownload）",
    ),
    (
        re.compile(r"getattr\(storage,"),
        set(),
        "storage 能力探測（duck-typing）已廢除：get_cached_bytes/put_cache_only 是基類方法，直接呼叫",
    ),
]

SCAN_DIRS = ["backend", "frontend/src", "frontend/tests", "tests", "scripts"]
SCAN_SUFFIXES = {".py", ".js", ".jsx", ".mjs"}
SELF = Path(__file__).resolve()


def main() -> int:
    violations = []
    for scan_dir in SCAN_DIRS:
        for path in (REPO_ROOT / scan_dir).rglob("*"):
            if path.suffix not in SCAN_SUFFIXES or not path.is_file():
                continue
            if path.resolve() == SELF or "node_modules" in path.parts:
                continue
            relative = path.relative_to(REPO_ROOT).as_posix()
            try:
                source = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for pattern, allowed, reason in RULES:
                if relative in allowed:
                    continue
                for line_number, line in enumerate(source.split("\n"), start=1):
                    if pattern.search(line):
                        violations.append(f"{relative}:{line_number}: [{pattern.pattern}] {reason}")

    if violations:
        print("禁用模式檢查失敗：以下位置繞過了唯一入口——")
        for violation in violations:
            print(" ", violation)
        return 1
    print(f"禁用模式檢查通過（{len(RULES)} 條規則）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
