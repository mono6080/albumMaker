import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const isWindows = process.platform === "win32";
let supervisor = null;
let stopping = false;

async function waitForUrl(url, timeoutMs = 90_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`E2E server did not become ready: ${url}`);
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (!isWindows) {
    child.kill("SIGTERM");
    await new Promise(resolveStop => child.once("exit", resolveStop));
    return;
  }
  await new Promise(resolveStop => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("exit", resolveStop);
    killer.once("error", resolveStop);
  });
}

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
    stdio: "inherit",
  });
  try {
    await Promise.all([
      waitForUrl("http://127.0.0.1:8765/api/health"),
      waitForUrl("http://127.0.0.1:5173/login"),
    ]);
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
