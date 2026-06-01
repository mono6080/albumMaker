import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, "..");
const isWindows = process.platform === "win32";
const children = [];

function startProcess(name, command, args) {
  const child = spawn(command, args, {
    cwd: frontendDir,
    env: process.env,
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", data => process.stdout.write(prefixLines(name, data)));
  child.stderr.on("data", data => process.stderr.write(prefixLines(name, data)));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${name}] exited ${signal ?? code}`);
    shutdown(code || 1);
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

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of [...children].reverse()) {
    if (!child.killed) child.kill(isWindows ? "SIGTERM" : "SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

startProcess("backend", isWindows ? "python.exe" : "python", ["../scripts/e2e_server.py"]);
startProcess("vite", isWindows ? "npm.cmd" : "npm", ["run", "dev", "--", "--host", "127.0.0.1"]);

try {
  await waitForUrl("backend", "http://127.0.0.1:8765/api/health", 60_000);
  await waitForUrl("vite", "http://127.0.0.1:5173", 90_000);
  console.log("[ready] run tests with: npm run test:e2e:reuse -- -g <pattern>");
  process.stdin.resume();
} catch (error) {
  console.error(error.message);
  shutdown(1);
}
