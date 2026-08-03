import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  E2E_WORKERS,
  assertFixedPortsAvailable,
  createSupervisorReadyMessage,
  stopOwnedProcessTrees,
} from "./e2e-supervisor-utils.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const isWindows = process.platform === "win32";
const children = [];

function startProcess(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: frontendDir,
    env: { ...process.env, ...extraEnv },
    shell: isWindows,
    detached: !isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", data => process.stdout.write(prefixLines(name, data)));
  child.stderr.on("data", data => process.stderr.write(prefixLines(name, data)));
  child.on("error", error => {
    if (shuttingDown) return;
    console.error(`[${name}] failed to start: ${error.message}`);
    void shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited ${signal ?? code}`);
    void shutdown(code || 1);
  });

  children.push(child);
  return child;
}

function prefixLines(name, data) {
  return data
    .toString()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => `[${name}] ${line}\n`)
    .join("");
}

function assertChildrenRunning() {
  const exited = children.find(
    child => child.exitCode !== null || child.signalCode !== null,
  );
  if (shuttingDown || exited) {
    throw new Error("E2E child server exited before supervisor ownership was ready.");
  }
}

async function waitForUrl(name, url, timeoutMs) {
  const startedAt = Date.now();
  let attempts = 0;
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) {
        const elapsed = Date.now() - startedAt;
        console.log(`[ready] ${name} ${url} in ${elapsed}ms (${attempts} attempts)`);
        return;
      }
    } catch {
      // Wait until the server is listening.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopOwnedProcessTrees(children);
  process.exit(exitCode);
}

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });

async function main() {
  await assertFixedPortsAvailable();
  // 每個 Playwright worker 一組獨立的 (backend, vite)：資料庫互不相干，
  // 才敢把 workers 開大於 1，也才不會出現「單獨跑會過、跑全套會掛」。
  for (let index = 0; index < E2E_WORKERS; index += 1) {
    const backendPort = 8765 + index;
    const vitePort = 5173 + index;
    startProcess(
      `backend${index}`,
      isWindows ? "python.exe" : "python",
      ["../scripts/e2e_server.py"],
      { ALBUM_MAKER_E2E_INDEX: String(index) },
    );
    startProcess(
      `vite${index}`,
      isWindows ? "npm.cmd" : "npm",
      ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
      { VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}` },
    );
  }

  for (let index = 0; index < E2E_WORKERS; index += 1) {
    await waitForUrl(`backend${index}`, `http://127.0.0.1:${8765 + index}/api/health`, 60_000);
    await waitForUrl(`vite${index}`, `http://127.0.0.1:${5173 + index}`, 90_000);
  }
  // 讓已排入 event loop 的 child exit 先落地，避免舊 URL 回應造成假 ready。
  await new Promise(resolveTurn => setImmediate(resolveTurn));
  assertChildrenRunning();
  process.send?.(createSupervisorReadyMessage());
  console.log("[ready] run tests with: npm run test:e2e:reuse -- -g <pattern>");
  process.stdin.resume();
}

main().catch(error => {
  console.error(`[fatal] ${error.message}`);
  void shutdown(1);
});
