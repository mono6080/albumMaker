"""園所編制、名單與專案授權的 process-local 寫鎖。"""

import threading


# 生命週期操作可能在同一執行緒內呼叫另一個組織 use case，需允許重入。
# 跨模組鎖順序固定為 organization → template → sorted project locks。
organization_acl_lock = threading.RLock()
