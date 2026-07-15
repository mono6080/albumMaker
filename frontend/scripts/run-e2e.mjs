import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stopProcessTree,
  waitForSupervisorReady,
} from "./e2e-supervisor-utils.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const isWindows = process.platform === "win32";
let supervisor = null;
let stopping = false;

async function cleanup() {
  if (stopping) return;
  stopping = true;
  await stopProcessTree(supervisor);
}

async function runPlaywright() {
  const command = resolve(
    frontendDir,
    "node_modules",
    ".bin",
    isWindows ? "playwright.cmd" : "playwright",
  );
  const child = spawn(command, ["test", ...process.argv.slice(2)], {
    cwd: frontendDir,
    env: { ...process.env, PLAYWRIGHT_SKIP_WEB_SERVER: "1" },
    shell: isWindows,
    stdio: "inherit",
  });
  return await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit(signal ? 1 : (code ?? 1)));
  });
}

async function main() {
  supervisor = spawn(process.execPath, [resolve(scriptDir, "e2e-local-servers.mjs")], {
    cwd: frontendDir,
    env: process.env,
    detached: !isWindows,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  try {
    // 只接受本次 child supervisor 的 IPC ready；舊 server 回應 URL 不算就緒。
    await waitForSupervisorReady(supervisor);
    return await runPlaywright();
  } finally {
    await cleanup();
  }
}

process.on("SIGINT", () => { void cleanup().finally(() => process.exit(130)); });
process.on("SIGTERM", () => { void cleanup().finally(() => process.exit(143)); });

main()
  .then(code => { process.exitCode = code; })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
