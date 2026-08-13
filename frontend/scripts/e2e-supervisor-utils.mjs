import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

export const E2E_SUPERVISOR_READY_MESSAGE = "e2e-supervisor-ready-v1";

export const E2E_WORKERS = Math.max(1, Number(process.env.E2E_WORKERS ?? 2));

// 本機開發後端佔著 8765 時，用 E2E_PORT_OFFSET 把整組 e2e port 一起挪開；
// 預設 0，CI 與既有指令的 port 不變。Python 端 scripts/e2e_server.py 讀同一個變數。
export const E2E_PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0);

export function e2eBackendPort(workerIndex) {
  return 8765 + E2E_PORT_OFFSET + workerIndex;
}

export function e2eVitePort(workerIndex) {
  return 5173 + E2E_PORT_OFFSET + workerIndex;
}

// 每個 worker 一組 (backend, vite)，port 依序往上長
export const E2E_FIXED_SERVERS = Object.freeze(
  Array.from({ length: E2E_WORKERS }, (_unused, index) => ([
    Object.freeze({ name: `backend${index}`, host: "127.0.0.1", port: e2eBackendPort(index) }),
    Object.freeze({ name: `vite${index}`, host: "127.0.0.1", port: e2eVitePort(index) }),
  ])).flat(),
);

function hasListeningServer({ host, port }, timeoutMs = 1_000) {
  return new Promise(resolveListening => {
    const socket = createConnection({ host, port });
    let settled = false;
    socket.unref();
    socket.setTimeout(timeoutMs);

    function finish(listening) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveListening(listening);
    }

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    // Loopback 連線逾時採 fail-closed，避免把無回應的 listener 當成空閒埠。
    socket.once("timeout", () => finish(true));
  });
}

function inspectBindablePort({ host, port }) {
  return new Promise(resolveInspection => {
    const server = createServer();
    server.unref();

    server.once("error", error => {
      resolveInspection({ available: false, error });
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(error => {
        resolveInspection({ available: !error, error: error ?? null });
      });
    });
  });
}

async function inspectPort(server) {
  // Windows 可能允許 specific-address bind 與既有 wildcard listener 並存，
  // 因此必須先連線偵測實際 listener，再用 bind 補捉非 listening reservation。
  if (await hasListeningServer(server)) {
    return { available: false, error: null };
  }
  return inspectBindablePort(server);
}

export async function assertFixedPortsAvailable(servers = E2E_FIXED_SERVERS) {
  const inspections = await Promise.all(
    servers.map(async server => ({
      server,
      ...(await inspectPort(server)),
    })),
  );
  const blocked = inspections.filter(inspection => !inspection.available);
  if (blocked.length === 0) return;

  const addresses = blocked
    .map(({ server }) => `${server.name} ${server.host}:${server.port}`)
    .join(", ");
  throw new Error(
    `E2E fixed-port ownership check failed: ${addresses} already occupied. `
      + "Stop the non-supervisor process before starting this E2E run.",
  );
}

export function createSupervisorReadyMessage() {
  return {
    type: E2E_SUPERVISOR_READY_MESSAGE,
    pid: process.pid,
    servers: E2E_FIXED_SERVERS.map(server => ({ ...server })),
  };
}

export function waitForSupervisorReady(child, timeoutMs = 90_000) {
  return new Promise((resolveReady, rejectReady) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      rejectReady(new Error("E2E supervisor exited before claiming its fixed ports."));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(new Error("E2E supervisor did not claim its fixed ports in time."));
    }, timeoutMs);
    timeout.unref?.();

    function cleanup() {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    }

    function onMessage(message) {
      if (
        message?.type !== E2E_SUPERVISOR_READY_MESSAGE
        || message.pid !== child.pid
      ) {
        return;
      }
      cleanup();
      resolveReady(message);
    }

    function onError(error) {
      cleanup();
      rejectReady(error);
    }

    function onExit(code, signal) {
      cleanup();
      rejectReady(new Error(
        `E2E supervisor exited before claiming its fixed ports (${signal ?? code ?? "unknown"}).`,
      ));
    }

    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise(resolveExit => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();

    function finish(exited) {
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolveExit(exited);
    }

    function onExit() {
      finish(true);
    }

    child.once("exit", onExit);
  });
}

export async function stopProcessTree(child, timeoutMs = 5_000) {
  if (
    !child
    || !Number.isInteger(child.pid)
    || child.exitCode !== null
    || child.signalCode !== null
  ) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise(resolveStop => {
      // 僅以本次 spawn 回傳的根 PID 清理，不依連接埠或程序名稱誤殺外部服務。
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("exit", resolveStop);
      killer.once("error", resolveStop);
    });
    return;
  }

  try {
    // 呼叫端在 POSIX 必須以 detached 建立獨立 process group。
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }

  await waitForExit(child, timeoutMs);
  try {
    // 根程序先退出時，process group 內仍可能留有孫程序；確認後一併清掉。
    process.kill(-child.pid, 0);
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export async function stopOwnedProcessTrees(children, stopTree = stopProcessTree) {
  await Promise.all([...children].reverse().map(child => stopTree(child)));
}
