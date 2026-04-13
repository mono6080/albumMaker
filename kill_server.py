import subprocess
import re
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PORT = 8765

# 找出監聽指定 port 的所有 PID
result = subprocess.run(
    ["netstat", "-ano"],
    capture_output=True, text=True, encoding="utf-8", errors="ignore"
)

listening_pids = set()
for line in result.stdout.splitlines():
    if f":{PORT}" in line and "LISTENING" in line:
        parts = line.split()
        if parts:
            listening_pids.add(parts[-1])

if not listening_pids:
    print(f"沒有進程在監聽 port {PORT}。")
    sys.exit(0)

# 對每個主進程，找出其子進程一併結束
all_pids = set(listening_pids)
for pid in list(listening_pids):
    child_result = subprocess.run(
        ["wmic", "process", "where", f"ParentProcessId={pid}", "get", "ProcessId"],
        capture_output=True, text=True, encoding="utf-8", errors="ignore"
    )
    for line in child_result.stdout.splitlines():
        line = line.strip()
        if re.match(r"^\d+$", line):
            all_pids.add(line)

# 逐一強制結束
for pid in all_pids:
    kill = subprocess.run(
        ["taskkill", "/F", "/PID", pid],
        capture_output=True, text=True, encoding="utf-8", errors="ignore"
    )
    if "成功" in kill.stdout or "SUCCESS" in kill.stdout.upper():
        print(f"  已結束 PID {pid}")
    else:
        print(f"  PID {pid}：{kill.stdout.strip() or kill.stderr.strip()}")

print("完成。")
