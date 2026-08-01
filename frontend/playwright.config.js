import { defineConfig, devices } from "@playwright/test";

const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1";
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";

const config = {
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  // CI 的 runner 上 webkit 會整個 crash（"Page crashed"），那是瀏覽器層的意外、
  // 不是斷言不成立。本機不重試，紅了就是紅了。重試成功的會被標成 flaky 而不是
  // passed，訊號不會被吃掉。
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
};

if (!skipWebServer) {
  // 單一 supervisor 同時管理 backend/Vite，Windows 才能在測試後清完整行程樹。
  config.webServer = {
    command: "npm run dev:e2e",
    url: "http://127.0.0.1:8765/api/health",
    reuseExistingServer,
    timeout: 90_000,
  };
}

export default defineConfig(config);
