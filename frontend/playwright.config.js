import { defineConfig, devices } from "@playwright/test";

const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1";
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1";
// 與 scripts/e2e-supervisor-utils.mjs 同一個 offset（預設 0）
const portOffset = Number(process.env.E2E_PORT_OFFSET ?? 0);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${5173 + portOffset}`;


// 只有「瀏覽器引擎差異真的會咬人」的地方才值得跑第二顆引擎：畫布渲染與幾何、
// 觸控手勢、縮圖與裁切的版面計算。純表單 CRUD 在 webkit 再跑一次，2026-08 的
// 實測是 371 秒的 e2e 時間裡零個產品 bug——買到的只有瀏覽器自己的崩潰與逾時。
const BROWSER_SENSITIVE_SPECS = [
  "**/template-editor.spec.js",
  "**/template-editor-mobile.spec.js",
  "**/illustrator-groups.spec.js",
  "**/editor-multi-transform.spec.js",
  "**/student-photos.spec.js",
  "**/mobile-student-edit.spec.js",
  "**/term-placement-board.spec.js",
];

// 壓力／效能測試：靠大量固定等待製造真實時序，本質上就是慢（兩支合計約 95 秒），
// 而且每次 push 都跑並不會更早發現問題。預設不跑，用 npm run test:e2e:soak 手動觸發。
const SOAK_SPECS = [
  "**/preview-switching.spec.js",
  "**/preview-interrupt-recovery.spec.js",
];

function buildProjects() {
  if (process.env.E2E_SOAK === "1") {
    return [{
      name: "soak",
      use: { ...devices["Desktop Chrome"] },
      testMatch: SOAK_SPECS,
    }];
  }
  return [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: SOAK_SPECS,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: BROWSER_SENSITIVE_SPECS,
    },
  ];
}

const config = {
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  // 檔案之間平行、檔案內部依序：每個 worker 有自己的後端與資料庫（見 tests/e2e/fixtures.js），
  // 所以平行是安全的；同一個檔案裡的測試仍照順序，因為它們常共用前面建立的資料。
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS ?? 2),
  // CI 的 runner 上 webkit 會整個 crash（"Page crashed"），那是瀏覽器層的意外、
  // 不是斷言不成立。本機不重試，紅了就是紅了。重試成功的會被標成 flaky 而不是
  // passed，訊號不會被吃掉。
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    // retain-on-failure 是「每一次都錄、成功才丟掉」，webkit 錄 trace 很吃記憶體，
    // CI 的 runner 上會直接 "Page crashed"。改成只有重試時才錄：第一次跑不帶負擔，
    // 真的失敗時第二次仍然留得到 trace 可以查。
    trace: "on-first-retry",
  },
  projects: buildProjects(),
};

if (!skipWebServer) {
  // 單一 supervisor 同時管理 backend/Vite，Windows 才能在測試後清完整行程樹。
  config.webServer = {
    command: "npm run dev:e2e",
    url: `http://127.0.0.1:${8765 + portOffset}/api/health`,
    reuseExistingServer,
    timeout: 90_000,
  };
}

export default defineConfig(config);
