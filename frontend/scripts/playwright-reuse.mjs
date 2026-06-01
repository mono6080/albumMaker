import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const command = resolve(
  frontendDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "playwright.cmd" : "playwright",
);
const child = spawn(command, ["test", ...process.argv.slice(2)], {
  env: {
    ...process.env,
    PLAYWRIGHT_REUSE_SERVER: "1",
    PLAYWRIGHT_SKIP_WEB_SERVER: "1",
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
