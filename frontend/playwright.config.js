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
  ],
};

if (!skipWebServer) {
  config.webServer = [
    {
      command: "python ../scripts/e2e_server.py",
      url: "http://127.0.0.1:8765/api/health",
      reuseExistingServer,
      timeout: 30_000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1",
      url: "http://127.0.0.1:5173",
      reuseExistingServer,
      timeout: 30_000,
    },
  ];
}

export default defineConfig(config);
