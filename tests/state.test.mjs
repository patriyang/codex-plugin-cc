import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { writeJsonFileAtomic } from "../plugins/codex/scripts/lib/fs.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob,
  withJobPersistenceLock,
  withStatePersistenceLock
} from "../plugins/codex/scripts/lib/state.mjs";

delete process.env.CLAUDE_PLUGIN_DATA;

function sleepSynchronously(milliseconds) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    sleepSynchronously(5);
  }
  assert.equal(fs.existsSync(filePath), true, `Timed out waiting for ${filePath}`);
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir prefers the namespaced plugin data dir over the shared CLAUDE_PLUGIN_DATA", () => {
  const workspace = makeTempDir();
  const ownPluginDataDir = makeTempDir();
  const foreignPluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const previousOwnPluginDataDir = process.env.CODEX_COMPANION_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = foreignPluginDataDir;
  process.env.CODEX_COMPANION_PLUGIN_DATA = ownPluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(ownPluginDataDir, "state")), true);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
    if (previousOwnPluginDataDir == null) {
      delete process.env.CODEX_COMPANION_PLUGIN_DATA;
    } else {
      process.env.CODEX_COMPANION_PLUGIN_DATA = previousOwnPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("writeJsonFileAtomic leaves no temp file behind when the write cannot land", () => {
  const directory = makeTempDir();
  // A directory at the destination fails the rename, which is the only failure
  // path where this call owns a temp file that still needs cleaning up.
  const target = path.join(directory, "blocked.json");
  fs.mkdirSync(target);

  assert.throws(() => writeJsonFileAtomic(target, { hello: "world" }));
  assert.deepEqual(
    fs.readdirSync(directory).filter((entry) => entry.includes(".tmp-")),
    []
  );
});

test("unlocked readers never observe a partially written state file", async () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const stateModuleUrl = new URL(
    "../plugins/codex/scripts/lib/state.mjs",
    import.meta.url
  ).href;
  const jobCount = 50;
  const payloadLength = 2048;
  const iterations = 75;
  const makeState = (iteration) => ({
    version: 1,
    config: { stopReviewGate: false },
    jobs: Array.from({ length: jobCount }, (_, index) => ({
      id: `job-${index}`,
      status: "running",
      iteration,
      payload: "x".repeat(payloadLength)
    }))
  });

  saveState(workspace, makeState(0));

  const childScript = [
    `const { saveState } = await import(${JSON.stringify(stateModuleUrl)});`,
    `const jobCount = ${jobCount};`,
    `const payloadLength = ${payloadLength};`,
    `const iterations = ${iterations};`,
    "for (let iteration = 0; iteration < iterations; iteration += 1) {",
    "  saveState(process.env.WORKSPACE, {",
    "    version: 1,",
    "    config: { stopReviewGate: false },",
    "    jobs: Array.from({ length: jobCount }, (_, index) => ({",
    "      id: `job-${index}`,",
    "      status: \"running\",",
    "      iteration,",
    "      payload: \"x\".repeat(payloadLength)",
    "    }))",
    "  });",
    "}"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
    env: {
      ...process.env,
      WORKSPACE: workspace
    },
    stdio: "ignore"
  });
  const childExit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const tornReads = [];
  let completeReads = 0;

  while (child.exitCode === null) {
    try {
      const raw = fs.readFileSync(stateFile, "utf8");
      try {
        const parsed = JSON.parse(raw);
        completeReads += 1;
        if (!parsed || !Array.isArray(parsed.jobs) || parsed.jobs.length < jobCount) {
          tornReads.push(`jobs=${parsed?.jobs?.length ?? "missing"} tail=${JSON.stringify(raw.slice(-120))}`);
        }
      } catch (error) {
        tornReads.push(`${error.message} tail=${JSON.stringify(raw.slice(-120))}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  const { code, signal } = await childExit;
  assert.equal(code, 0, `state writer exited with code ${code} and signal ${signal}`);
  // Without this the test would pass vacuously if the reader never saw the file at all.
  assert.ok(completeReads > 0, "expected the reader to observe the state file while the writer ran");
  assert.equal(
    tornReads.length,
    0,
    `observed ${tornReads.length} torn reads:\n${tornReads.slice(0, 10).join("\n")}`
  );
});

test("config and different-job updates retain both results under the workspace state lock", () => {
  const workspace = makeTempDir();
  const readyFile = path.join(workspace, "state-writer-ready");
  const doneFile = path.join(workspace, "state-writer-done");
  const stateModuleUrl = new URL(
    "../plugins/codex/scripts/lib/state.mjs",
    import.meta.url
  ).href;
  const childScript = [
    'import fs from "node:fs";',
    `const { setConfig, upsertJob } = await import(${JSON.stringify(stateModuleUrl)});`,
    'fs.writeFileSync(process.env.READY_FILE, "ready", "utf8");',
    'setConfig(process.env.WORKSPACE, "stopReviewGate", true);',
    'upsertJob(process.env.WORKSPACE, { id: "job-b", status: "running" });',
    'fs.writeFileSync(process.env.DONE_FILE, "done", "utf8");'
  ].join("\n");

  let child = null;
  withStatePersistenceLock(workspace, () => {
    const staleState = loadState(workspace);
    child = spawn(process.execPath, ["--input-type=module", "-e", childScript], {
      env: {
        ...process.env,
        DONE_FILE: doneFile,
        READY_FILE: readyFile,
        WORKSPACE: workspace
      },
      stdio: "ignore"
    });
    waitForFile(readyFile);
    sleepSynchronously(100);
    staleState.jobs.unshift({
      id: "job-a",
      status: "running",
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z"
    });
    fs.writeFileSync(resolveStateFile(workspace), `${JSON.stringify(staleState, null, 2)}\n`, "utf8");
  });
  waitForFile(doneFile);
  if (child.exitCode === null) {
    child.kill();
  }

  const state = loadState(workspace);
  assert.equal(state.config.stopReviewGate, true);
  const jobs = state.jobs;
  assert.equal(jobs.some((job) => job.id === "job-a"), true);
  assert.equal(jobs.some((job) => job.id === "job-b"), true);
});

test("persistence lock preserves a live owner even when its file is old", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveJobsDir(workspace), "live-owner.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    `${JSON.stringify({ token: "live-owner", pid: 4321, pidStartTime: "live-start" })}\n`,
    "utf8"
  );
  const oldTime = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, oldTime, oldTime);

  assert.throws(
    () =>
      withJobPersistenceLock(
        workspace,
        "live-owner",
        () => {},
        {
          timeoutMs: 25,
          isProcessAlive: () => true,
          getProcessStartTime: () => "live-start"
        }
      ),
    /Timed out acquiring persistence lock/
  );
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "live-owner");
});

test("persistence lock removes its file when owner metadata writing fails", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveJobsDir(workspace), "metadata-failure.lock");
  const originalWriteFileSync = fs.writeFileSync;
  const injectedError = new Error("injected owner metadata write failure");
  let callbackRan = false;

  fs.writeFileSync = (...args) => {
    if (typeof args[0] === "number") {
      throw injectedError;
    }
    return originalWriteFileSync.apply(fs, args);
  };

  try {
    assert.throws(
      () => withJobPersistenceLock(workspace, "metadata-failure", () => {}),
      (error) => error === injectedError
    );
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  withJobPersistenceLock(
    workspace,
    "metadata-failure",
    () => {
      callbackRan = true;
    },
    { timeoutMs: 1500, retryMs: 100 }
  );
  assert.equal(callbackRan, true);
});

test("persistence lock preserves an owner with an unavailable identity", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveJobsDir(workspace), "ambiguous-owner.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    `${JSON.stringify({ token: "ambiguous-owner", pid: 4321, pidStartTime: null })}\n`,
    "utf8"
  );

  assert.throws(
    () =>
      withJobPersistenceLock(workspace, "ambiguous-owner", () => {}, {
        timeoutMs: 25,
        isProcessAlive: () => false,
        getProcessStartTime: () => null
      }),
    /Timed out acquiring persistence lock/
  );
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "ambiguous-owner");
});

test("persistence lock recovers dead and replaced owners", () => {
  for (const [label, isAlive, getStartTime] of [
    ["dead", () => false, () => null],
    ["replaced", () => true, () => "new-start"]
  ]) {
    const workspace = makeTempDir();
    const lockFile = path.join(resolveJobsDir(workspace), `${label}-owner.lock`);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({ token: `${label}-owner`, pid: 4321, pidStartTime: "old-start" })}\n`,
      "utf8"
    );
    let callbackRan = false;
    withJobPersistenceLock(
      workspace,
      `${label}-owner`,
      () => {
        callbackRan = true;
      },
      {
        timeoutMs: 100,
        isProcessAlive: isAlive,
        getProcessStartTime: getStartTime
      }
    );
    assert.equal(callbackRan, true);
    assert.equal(fs.existsSync(lockFile), false);
  }
});

test("persistence lock release does not remove a replacement lock", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveJobsDir(workspace), "replacement-owner.lock");
  withJobPersistenceLock(
    workspace,
    "replacement-owner",
    () => {
      const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      assert.match(owner.token, /^[0-9a-f-]{36}$/);
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.pidStartTime, "owner-start");
      fs.writeFileSync(
        lockFile,
        `${JSON.stringify({ token: "replacement-owner", pid: 4321, pidStartTime: "replacement-start" })}\n`,
        "utf8"
      );
    },
    { getProcessStartTime: () => "owner-start" }
  );

  assert.equal(fs.existsSync(lockFile), true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "replacement-owner");
});
