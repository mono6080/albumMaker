import { defineConfig, devices } from "@playwright/test";

const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_SERVER === "1";
const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "1";

const config = {
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
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
