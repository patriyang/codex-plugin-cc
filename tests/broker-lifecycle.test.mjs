import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;
process.env.CLAUDE_PLUGIN_DATA = makeTempDir();

function brokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "broker.json");
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for process ${pid} to exit.`);
}

test("clearBrokerSession does not remove a newer broker session", () => {
  const workspace = makeTempDir();
  const sessionA = { endpoint: "unix:/tmp/broker-a.sock" };
  const sessionB = { endpoint: "unix:/tmp/broker-b.sock" };

  saveBrokerSession(workspace, sessionA);
  const loadedByA = loadBrokerSession(workspace);
  saveBrokerSession(workspace, sessionB);

  const removed = clearBrokerSession(workspace, loadedByA);

  assert.equal(removed, false);
  assert.deepEqual(loadBrokerSession(workspace), sessionB);
});

test("clearBrokerSession removes a matching broker session", () => {
  const workspace = makeTempDir();
  const session = { endpoint: "unix:/tmp/matching-broker.sock" };
  saveBrokerSession(workspace, session);

  assert.equal(clearBrokerSession(workspace, session), true);
  assert.equal(loadBrokerSession(workspace), null);
});

test("clearBrokerSession removes an unparseable broker record", () => {
  const workspace = makeTempDir();
  saveBrokerSession(workspace, { endpoint: "unix:/tmp/unparseable-broker.sock" });
  fs.writeFileSync(brokerStateFile(workspace), "not json\n", "utf8");

  assert.equal(clearBrokerSession(workspace), true);
  assert.equal(fs.existsSync(brokerStateFile(workspace)), false);
});

test("clearBrokerSession leaves a foreign record alone without an expected session", () => {
  const workspace = makeTempDir();
  const session = { endpoint: "unix:/tmp/foreign-broker.sock" };
  saveBrokerSession(workspace, session);

  assert.equal(clearBrokerSession(workspace), false);
  assert.deepEqual(loadBrokerSession(workspace), session);
});

test("saveBrokerSession and clearBrokerSession serialize on the broker lock", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), "broker.lock");
  const pidStartTime = "live-start";
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    `${JSON.stringify({ token: "live-owner", pid: process.pid, pidStartTime })}\n`,
    "utf8"
  );
  const lockOptions = {
    timeoutMs: 25,
    isProcessAlive: () => true,
    getProcessStartTime: () => pidStartTime
  };

  assert.throws(
    () => saveBrokerSession(workspace, { endpoint: "unix:/tmp/save-timeout.sock" }, lockOptions),
    /Timed out acquiring persistence lock/
  );
  assert.throws(
    () => clearBrokerSession(workspace, { endpoint: "unix:/tmp/clear-timeout.sock" }, lockOptions),
    /Timed out acquiring persistence lock/
  );
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "live-owner");
});

// A broker that comes up on its endpoint but cannot publish its record: the lock is
// held by a live owner, so `saveBrokerSession` times out after the readiness check.
function startContendedBroker(t) {
  const workspace = makeTempDir();
  const fakeBroker = path.join(makeTempDir(), "fake-broker.mjs");
  const startedPidFile = path.join(makeTempDir(), "started.pid");
  const readyFile = path.join(makeTempDir(), "ready");
  const lockFile = path.join(resolveStateDir(workspace), "broker.lock");
  const pidStartTime = "live-start";

  writeExecutable(
    fakeBroker,
    `import fs from "node:fs";
import net from "node:net";
import process from "node:process";

const args = process.argv.slice(2);
const endpoint = args[args.indexOf("--endpoint") + 1];
const pidFile = args[args.indexOf("--pid-file") + 1];
const socketPath = endpoint.startsWith("unix:") ? endpoint.slice("unix:".length) : endpoint;
fs.writeFileSync(${JSON.stringify(startedPidFile)}, String(process.pid));
fs.writeFileSync(pidFile, String(process.pid));
const server = net.createServer();
server.listen(socketPath, () => fs.writeFileSync(${JSON.stringify(readyFile)}, "ready"));
`
  );

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    `${JSON.stringify({ token: "live-owner", pid: process.pid, pidStartTime })}\n`,
    "utf8"
  );

  const spawnedPid = () => Number(fs.readFileSync(startedPidFile, "utf8"));
  t.after(async () => {
    let pid;
    try {
      pid = spawnedPid();
      process.kill(pid, "SIGTERM");
    } catch {
      // The broker was already torn down by the test.
    }
    if (pid) {
      await waitForProcessExit(pid).catch(() => {});
    }
  });

  return {
    workspace,
    readyFile,
    spawnedPid,
    connect: (options = {}) =>
      ensureBrokerSession(workspace, {
        scriptPath: fakeBroker,
        timeoutMs: 2000,
        lockOptions: {
          timeoutMs: 25,
          isProcessAlive: () => true,
          getProcessStartTime: () => pidStartTime
        },
        ...options
      })
  };
}

// A broker that starts and stays alive but never listens on its endpoint: the readiness
// check times out while the process it spawned is still running.
function startUnreachableBroker(t) {
  const workspace = makeTempDir();
  const fakeBroker = path.join(makeTempDir(), "fake-broker.mjs");
  const startedPidFile = path.join(makeTempDir(), "started.pid");

  writeExecutable(
    fakeBroker,
    `import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const pidFile = args[args.indexOf("--pid-file") + 1];
fs.writeFileSync(${JSON.stringify(startedPidFile)}, String(process.pid));
fs.writeFileSync(pidFile, String(process.pid));
setInterval(() => {}, 1000);
`
  );

  const spawnedPid = () => Number(fs.readFileSync(startedPidFile, "utf8"));
  t.after(async () => {
    let pid;
    try {
      pid = spawnedPid();
      process.kill(pid, "SIGKILL");
    } catch {
      // The broker was already torn down by the test.
    }
    if (pid) {
      await waitForProcessExit(pid).catch(() => {});
    }
  });

  return {
    workspace,
    spawnedPid,
    connect: (options = {}) =>
      ensureBrokerSession(workspace, { scriptPath: fakeBroker, timeoutMs: 300, ...options })
  };
}

test("ensureBrokerSession kills a broker that never became ready", async (t) => {
  const broker = startUnreachableBroker(t);

  const session = await broker.connect();

  assert.equal(session, null);
  await waitForProcessExit(broker.spawnedPid());
  assert.equal(fs.existsSync(brokerStateFile(broker.workspace)), false);
});

test("ensureBrokerSession routes a never-ready broker through an injected killProcess", async (t) => {
  const broker = startUnreachableBroker(t);
  const killedPids = [];

  const session = await broker.connect({
    killProcess: (pid) => {
      killedPids.push(pid);
      process.kill(pid, "SIGTERM");
    }
  });

  assert.equal(session, null);
  assert.deepEqual(killedPids, [broker.spawnedPid()]);
  await waitForProcessExit(broker.spawnedPid());
});

test("ensureBrokerSession tears down the broker when publishing the session fails", async (t) => {
  const broker = startContendedBroker(t);
  const killedPids = [];

  const session = await broker.connect({
    killProcess: (pid) => {
      killedPids.push(pid);
      process.kill(pid, "SIGTERM");
    }
  });

  assert.equal(session, null);
  assert.equal(fs.existsSync(broker.readyFile), true);
  assert.deepEqual(killedPids, [broker.spawnedPid()]);
  await waitForProcessExit(broker.spawnedPid());
  assert.equal(fs.existsSync(brokerStateFile(broker.workspace)), false);
});

// Production callers (`CodexAppServerClient.connect`) pass no `killProcess`, so the
// injected spy above must not be what kills the broker.
test("ensureBrokerSession kills an unpublishable broker without a killProcess override", async (t) => {
  const broker = startContendedBroker(t);

  const session = await broker.connect();

  assert.equal(session, null);
  assert.equal(fs.existsSync(broker.readyFile), true);
  await waitForProcessExit(broker.spawnedPid());
  assert.equal(fs.existsSync(brokerStateFile(broker.workspace)), false);
});
