import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getProcessStartTime, isProcessAlive } from "../plugins/codex/scripts/lib/process.mjs";
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

test("ensureBrokerSession records the start time of the broker it publishes", async (t) => {
  const workspace = makeTempDir();
  const fakeBroker = path.join(makeTempDir(), "fake-broker.mjs");

  writeExecutable(
    fakeBroker,
    `import fs from "node:fs";
import net from "node:net";
import process from "node:process";

const args = process.argv.slice(2);
const endpoint = args[args.indexOf("--endpoint") + 1];
const pidFile = args[args.indexOf("--pid-file") + 1];
const socketPath = endpoint.startsWith("unix:") ? endpoint.slice("unix:".length) : endpoint;
fs.writeFileSync(pidFile, String(process.pid));
net.createServer().listen(socketPath);
`
  );

  const session = await ensureBrokerSession(workspace, { scriptPath: fakeBroker, timeoutMs: 2000 });
  assert.notEqual(session, null);
  t.after(async () => {
    try {
      process.kill(session.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    await waitForProcessExit(session.pid).catch(() => {});
  });

  assert.equal(typeof session.pidStartTime, "string");
  assert.equal(session.pidStartTime, getProcessStartTime(session.pid));
  assert.equal(loadBrokerSession(workspace).pidStartTime, session.pidStartTime);
});

// A record read off disk can be arbitrarily old, so its pid may have been recycled. The stale path
// must prove identity before signalling: `terminateProcessTree` targets a whole process group.
function stageStaleBrokerRecord(t, record) {
  const workspace = makeTempDir();
  const sessionDir = makeTempDir();
  const deadBroker = path.join(makeTempDir(), "dead-broker.mjs");
  writeExecutable(deadBroker, "process.exit(0);\n");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(async () => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await waitForProcessExit(sleeper.pid).catch(() => {});
  });

  saveBrokerSession(workspace, {
    // Never listened on, so the readiness probe fails and the stale teardown runs.
    endpoint: `unix:${path.join(sessionDir, "broker.sock")}`,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: sleeper.pid,
    ...record(sleeper.pid)
  });

  return {
    workspace,
    pid: sleeper.pid,
    connect: (options = {}) =>
      ensureBrokerSession(workspace, { scriptPath: deadBroker, timeoutMs: 300, ...options })
  };
}

test("ensureBrokerSession does not signal a stale record whose pid was recycled", async (t) => {
  const killedPids = [];
  const stale = stageStaleBrokerRecord(t, () => ({ pidStartTime: "1970-01-01T00:00:00.000Z" }));

  await stale.connect({ killProcess: (pid) => killedPids.push(pid) });

  assert.equal(killedPids.includes(stale.pid), false);
  assert.equal(isProcessAlive(stale.pid), true);
});

// Records written by older plugin versions carry no `pidStartTime`; with no proof of identity the
// pid stays unsignalled, which is what this path already did before it gained a real terminator.
test("ensureBrokerSession does not signal a stale record with no recorded start time", async (t) => {
  const killedPids = [];
  const stale = stageStaleBrokerRecord(t, () => ({}));

  await stale.connect({ killProcess: (pid) => killedPids.push(pid) });

  assert.equal(killedPids.includes(stale.pid), false);
  assert.equal(isProcessAlive(stale.pid), true);
});

// With identity proven the stale broker is a real orphan, and leaving it alive is #67's leak on the
// disk-record path: teardown unlinks its socket and pid file, so nothing on disk names it again.
test("ensureBrokerSession kills a verified stale broker without a killProcess override", async (t) => {
  const stale = stageStaleBrokerRecord(t, (pid) => ({ pidStartTime: getProcessStartTime(pid) }));

  await stale.connect();

  await waitForProcessExit(stale.pid);
});
