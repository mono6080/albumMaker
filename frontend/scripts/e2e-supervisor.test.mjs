import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import {
  E2E_SUPERVISOR_READY_MESSAGE,
  assertFixedPortsAvailable,
  stopOwnedProcessTrees,
  waitForSupervisorReady,
} from "./e2e-supervisor-utils.mjs";

function listenOnRandomPort(host = "127.0.0.1") {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer();
    server.once("error", rejectListen);
    server.listen({ host, port: 0 }, () => {
      resolveListen(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close(error => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

class FakeChild extends EventEmitter {
  constructor(pid = 43210) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
  }
}

test("fixed-port preflight reports an externally occupied port", async () => {
  const server = await listenOnRandomPort();
  const address = server.address();
  try {
    await assert.rejects(
      assertFixedPortsAvailable([
        { name: "occupied-test-server", host: "127.0.0.1", port: address.port },
      ]),
      error => {
        assert.match(error.message, /fixed-port ownership check failed/);
        assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${address.port}`));
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test("fixed-port preflight detects a wildcard listener from the loopback address", async () => {
  const server = await listenOnRandomPort("0.0.0.0");
  const address = server.address();
  try {
    await assert.rejects(
      assertFixedPortsAvailable([
        { name: "wildcard-test-server", host: "127.0.0.1", port: address.port },
      ]),
      new RegExp(`127\\.0\\.0\\.1:${address.port} already occupied`),
    );
  } finally {
    await closeServer(server);
  }
});

test("runner accepts ready only from its own supervisor child", async () => {
  const child = new FakeChild();
  const ready = waitForSupervisorReady(child, 1_000);

  child.emit("message", {
    type: E2E_SUPERVISOR_READY_MESSAGE,
    pid: child.pid + 1,
  });
  child.emit("message", {
    type: E2E_SUPERVISOR_READY_MESSAGE,
    pid: child.pid,
  });

  assert.equal((await ready).pid, child.pid);
});

test("runner fails when supervisor exits before claiming ports", async () => {
  const child = new FakeChild();
  const ready = waitForSupervisorReady(child, 1_000);
  child.emit("exit", 1, null);

  await assert.rejects(ready, /exited before claiming its fixed ports/);
});

test("cleanup visits only the process trees registered by this supervisor", async () => {
  const ownedChildren = [{ pid: 101 }, { pid: 202 }];
  const stoppedPids = [];

  await stopOwnedProcessTrees(ownedChildren, async child => {
    stoppedPids.push(child.pid);
  });

  assert.deepEqual(stoppedPids, [202, 101]);
});
