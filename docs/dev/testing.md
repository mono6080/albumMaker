# 測試與驗證

> Owns：測試指令、測試防線現況、agent 修改後的驗證流程。
> CI 在 `.github/workflows/tests.yml`，push / PR 時跑同一組 gate。

---

## 指令總覽

```bash
# 後端（repo 根目錄）
python -m pytest -q
python -m ruff check backend tests
python -m mypy backend tests

# 前端
cd frontend
npm run lint
npm run test:unit            # 自製 node runner 單元測試
npm run test:render-parity   # 前後端渲染一致性（見 rendering.md）
npm run test:e2e             # 乾淨 Playwright run（自起 e2e 後端與 Vite）
npm run build                # production bundle（改前端後必跑）
```

## 測試防線現況

- **後端 pytest**（`tests/`）：
  - `test_auth.py`、`test_migrations.py`（驗證 init_db + run_migrations 可重複執行）、
    `test_storage.py`（含 traversal shared-prefix regression）、
    `test_project_service.py`、`test_roster.py`（名冊自動連結、歧義配對、學期匯出 ZIP）
  - `test_api_smoke.py`：TestClient 覆蓋 health、login/logout cookie roundtrip、
    模板/專案/學生 CRUD、對應文字、留言角色、照片上傳/mapping、預覽、渲染、
    PDF / ZIP 下載；每個 TestClient context 會 reset slowapi limiter state
  - `test_api_edges.py`：401/404/413/415/422、storage missing、render failure、
    照片互換、corrupt JSON、角色矩陣負向案例
  - `test_render_regression.py`：固定版型 `tests/fixtures/render_smoke_layout.json`
    的寬鬆像素區域檢查
  - `conftest.py` 把測試 DB 指到 repo 內 `.tmp/pytest`
    （可用 `ALBUM_MAKER_TEST_TMPDIR` 覆寫），不污染 `backend/album_maker.db`
- **前端**：lint / unit / render-parity / Playwright E2E；無 vitest / RTL 元件測試
- **pre-commit**：`.pre-commit-config.yaml`（ruff check/format + mypy）；
  是否已在本機 install 不由 repo 保證
- `pyproject.toml` 關閉 pytest cache provider（本 repo 的 Windows ACL 對
  `.pytest_cache` 不穩）

## Playwright 反覆開發模式

反覆跑單一 e2e 測試時，先常駐 e2e 專用後端與 Vite，再用 reuse 模式：

```bash
cd frontend
npm run dev:e2e                          # 常駐：隔離 .tmp/e2e DB + 固定 e2e admin 密碼
npm run test:e2e:reuse -- -g multi-select
```

`test:e2e:reuse` 會略過 Playwright 的 `webServer` 啟動；**只在 `dev:e2e`
已常駐時使用**。

## Agent 修改後的驗證流程（必守）

改完程式**不能**直接回報「應該可以了」，必須自己先驗證：

- **後端邏輯**：跑 `python -m pytest -q`；涉及 API 行為再起
  `uvicorn --reload`，用 curl 或 Python 腳本實際打端點比對回應
  （Windows curl 中文限制見 [conventions.md](conventions.md#windows-開發環境注意)）
- **前端邏輯**：`npm run build` 後用 Playwright 或瀏覽器實際操作目標功能
- **渲染改動**：必跑 `test_render_regression.py` 與 `npm run test:render-parity`
- **DB schema 改動**：本機跑一次啟動（migration 自動執行），
  以 `PRAGMA table_info` 確認欄位 / 索引存在
- 確認輸出符合預期後才回報結果
