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
python scripts/check_banned_patterns.py   # 唯一入口繞道禁令（CI 也會跑）
python scripts/check_backend_route_boundaries.py  # 路由／service 邊界與既有債務清單

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
    `test_project_service.py`、`test_roster.py`（名冊自動連結、歧義配對、學期匯出 ZIP、
    專案全班完成鎖定/退回與空專案不可完成）
  - `test_api_smoke.py`：TestClient 覆蓋 health、login/logout cookie roundtrip、
    模板/專案/學生 CRUD、對應文字、留言角色、照片上傳/mapping、預覽、渲染、
    PDF / ZIP 下載；每個 TestClient context 會 reset slowapi limiter state
  - `test_api_edges.py`：401/404/413/415/422、storage missing、render failure、
    照片互換、corrupt JSON、角色矩陣負向案例
  - `test_render_regression.py`：固定版型 `tests/fixtures/render_smoke_layout.json`
    的寬鬆像素區域檢查
  - `test_contract_pins.py` / `test_font_parity.py`：前後端契約釘——
    design tokens 兩端一致、insets 演算法釘值、字型清單對應
    （防跨語言鏡像靜默漂移，規則見 [conventions.md](conventions.md#跨模組-invariants)）
  - `conftest.py` 把測試 DB 指到 repo 內 `.tmp/pytest`
    （可用 `ALBUM_MAKER_TEST_TMPDIR` 覆寫），不污染 `backend/album_maker.db`
  - `test_layout_groups.py`：v1/v2 group schema、safe canonical refs、任意深度 traversal、cycle 與
    malformed topology/link fallback
  - `test_material_text_box.py`：素材分析授權、namespace/revision、零寫入與 normalized box 契約
  - `test_backend_failure_contracts.py` / `test_user_transaction_contracts.py`：storage／DB 失敗與
    使用者批次匯入、刪除的 transaction 邊界
  - `test_backend_route_boundaries.py` + `scripts/check_backend_route_boundaries.py`：完整掃描
    `backend/routers/**/*.py` 的 route inventory，禁止新路由把 commit、storage mutation 或重業務邏輯
    留在 HTTP adapter；既有債務採精確 manifest，只能減少不能擴張
- **前端**：lint / unit / render-parity / Playwright E2E；無 vitest / RTL 元件測試。
  `tests/e2e/illustrator-groups.spec.js` 在 Chromium/WebKit 覆蓋通用／巢狀群組、逐層 isolation、marquee、
  Ctrl/Cmd+G、固定 typography、isolation 內 undo，以及分析建立／重設普通文字框、不改 topology、
  invalid-link 修復與跨頁 stale response guard。
  `tests/unit/photo-save.test.mjs` 覆蓋照片 single-flight、stale response、revision pause/resume 與卸載重掛；
  `tests/e2e/student-photos.spec.js` 驗證延遲上傳期間繼續移動仍收斂到最後狀態，
  `tests/e2e/template-editor-mobile.spec.js` 驗證 pinch 不重 render 畫布父層且不污染 dirty/undo/save。
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
