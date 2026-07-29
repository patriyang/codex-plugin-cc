import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { reapDeadJobs, resolveResultJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import {
  ensureStateDir,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateFile,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { initGitRepo, makeTempDir, spawnDeadPid } from "./helpers.mjs";

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;

test("reapDeadJobs returns a terminal job when persistence fails", () => {
  const pluginDataFile = path.join(makeTempDir(), "not-a-directory");
  fs.writeFileSync(pluginDataFile, "", "utf8");
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataFile;

  try {
    const updatedAt = "2026-07-26T08:00:00.000Z";
    const [job] = reapDeadJobs(
      makeTempDir(),
      [
        {
          id: "task-dead",
          status: "running",
          pid: 1234,
          updatedAt
        }
      ],
      {
        isProcessAlive: () => false
      }
    );

    assert.equal(job.status, "failed");
    assert.equal(job.phase, "failed");
    assert.equal(job.pid, null);
    assert.equal(job.reaped, true);
    assert.equal(job.completedAt, updatedAt);
  } finally {
    if (previousPluginData == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});

test("reapDeadJobs reaps an alive PID when its start time no longer matches", () => {
  const [job] = reapDeadJobs(
    makeTempDir(),
    [
      {
        id: "task-reused-pid",
        status: "running",
        pid: 1234,
        pidStartTime: "old-worker-start",
        updatedAt: "2026-07-28T08:00:00.000Z"
      }
    ],
    {
      isProcessAlive: () => true,
      getProcessStartTime: () => "new-worker-start"
    }
  );

  assert.equal(job.status, "failed");
  assert.equal(job.phase, "failed");
  assert.equal(job.pid, null);
  assert.equal(job.reaped, true);
});

test("reapDeadJobs preserves an alive job when its start time lookup is unavailable", () => {
  const originalJob = {
    id: "task-ambiguous-pid",
    status: "running",
    pid: 1234,
    pidStartTime: "worker-start",
    updatedAt: "2026-07-28T08:00:00.000Z"
  };
  const [job] = reapDeadJobs(makeTempDir(), [originalJob], {
    isProcessAlive: () => true,
    getProcessStartTime: () => null
  });

  assert.deepEqual(job, originalJob);
});

test("runTrackedJob persists the worker start time in its running record", async () => {
  const workspace = makeTempDir();
  const job = {
    id: "task-start-time",
    workspaceRoot: workspace,
    title: "Codex Task",
    status: "queued"
  };
  let runningRecord = null;

  await runTrackedJob(
    job,
    async () => {
      runningRecord = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
      return {
        exitStatus: 0,
        threadId: null,
        turnId: null,
        payload: {},
        rendered: "",
        summary: "done"
      };
    },
    {
      getProcessStartTime: () => "worker-start"
    }
  );

  assert.equal(runningRecord.pidStartTime, "worker-start");
  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(workspace, job.id), "utf8"));
  assert.equal(storedJob.pidStartTime, "worker-start");
});

test("reapDeadJobs preserves a completion stored after the job list was read", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const jobId = "task-completed";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "Worker finished successfully.\n", "utf8");
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "completed",
    pid: null,
    logFile,
    completedAt: "2026-07-26T08:01:00.000Z",
    result: { message: "done" }
  });
  const jobFile = resolveJobFile(workspace, jobId);
  const storedBefore = fs.readFileSync(jobFile, "utf8");
  const logBefore = fs.readFileSync(logFile, "utf8");

  const [job] = reapDeadJobs(
    workspace,
    [
      {
        id: jobId,
        status: "running",
        pid: 1234,
        logFile,
        updatedAt: "2026-07-26T08:00:00.000Z"
      }
    ],
    {
      isProcessAlive: () => false
    }
  );

  assert.equal(job.status, "completed");
  assert.deepEqual(job.result, { message: "done" });
  assert.equal(fs.readFileSync(jobFile, "utf8"), storedBefore);
  assert.equal(fs.readFileSync(logFile, "utf8"), logBefore);
  assert.deepEqual(listJobs(workspace), []);
});

test("reapDeadJobs does not repeat a partial reap whose stored record is terminal", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const jobId = "task-partially-reaped";
  const logFile = resolveJobLogFile(workspace, jobId);
  const pid = 1234;
  upsertJob(workspace, {
    id: jobId,
    status: "running",
    pid,
    logFile,
    updatedAt: "2026-07-26T08:00:00.000Z"
  });
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "failed",
    phase: "failed",
    pid: null,
    logFile,
    completedAt: "2026-07-26T08:01:00.000Z",
    errorMessage: `Worker process ${pid} is no longer running; the job ended without recording a result.`,
    reaped: true,
    result: { partial: true }
  });
  fs.writeFileSync(logFile, "Job reaped: worker process 1234 is gone; marking failed.\n", "utf8");

  const jobFile = resolveJobFile(workspace, jobId);
  const stateFile = resolveStateFile(workspace);
  const fixedMtime = new Date("2026-07-26T08:02:00.000Z");
  fs.utimesSync(jobFile, fixedMtime, fixedMtime);
  fs.utimesSync(logFile, fixedMtime, fixedMtime);
  const storedBefore = fs.readFileSync(jobFile, "utf8");
  const stateBefore = fs.readFileSync(stateFile, "utf8");
  const logBefore = fs.readFileSync(logFile, "utf8");

  const [job] = reapDeadJobs(workspace, listJobs(workspace), {
    isProcessAlive: () => false
  });

  assert.equal(job.status, "failed");
  assert.equal(job.reaped, true);
  assert.deepEqual(job.result, { partial: true });
  assert.equal(fs.readFileSync(jobFile, "utf8"), storedBefore);
  assert.equal(fs.readFileSync(stateFile, "utf8"), stateBefore);
  assert.equal(fs.readFileSync(logFile, "utf8"), logBefore);
  assert.equal(fs.statSync(jobFile).mtime.toISOString(), fixedMtime.toISOString());
  assert.equal(fs.statSync(logFile).mtime.toISOString(), fixedMtime.toISOString());
  assert.equal(logBefore.match(/Job reaped:/g)?.length, 1);
});

test("resolveResultJob reaps jobs before applying the session filter", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  ensureStateDir(workspace);
  upsertJob(workspace, {
    id: "task-current",
    status: "completed",
    sessionId: "sess-current"
  });
  upsertJob(workspace, {
    id: "task-other",
    status: "running",
    sessionId: "sess-other",
    pid: spawnDeadPid()
  });

  const previousSessionId = process.env.CODEX_COMPANION_SESSION_ID;
  process.env.CODEX_COMPANION_SESSION_ID = "sess-current";
  try {
    const { job } = resolveResultJob(workspace, "");
    assert.equal(job.id, "task-current");

    const reaped = listJobs(workspace).find((candidate) => candidate.id === "task-other");
    assert.equal(reaped.status, "failed");
    assert.equal(reaped.reaped, true);
  } finally {
    if (previousSessionId == null) {
      delete process.env.CODEX_COMPANION_SESSION_ID;
    } else {
      process.env.CODEX_COMPANION_SESSION_ID = previousSessionId;
    }
  }
});
