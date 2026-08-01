import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  persistJobCancellation,
  reapDeadJobs,
  resolveCancelableJob,
  resolveResultJob
} from "../plugins/codex/scripts/lib/job-control.mjs";
import {
  ensureStateDir,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveStateFile,
  upsertJob,
  withJobPersistenceLock,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { initGitRepo, makeTempDir, spawnDeadPid } from "./helpers.mjs";

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;

test("reapDeadJobs reports an in-memory reap when the persistence lock fails", () => {
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

test("reapDeadJobs preserves the stored job when writing the reap fails", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const jobId = "task-write-failure";
  const runningJob = {
    id: jobId,
    status: "running",
    phase: "running",
    pid: 1234,
    updatedAt: "2026-07-26T08:00:00.000Z"
  };
  writeJobFile(workspace, jobId, runningJob);
  upsertJob(workspace, runningJob);
  const jobFile = resolveJobFile(workspace, jobId);
  const storedBefore = fs.readFileSync(jobFile, "utf8");

  let writeAttempts = 0;
  const [job] = reapDeadJobs(workspace, [runningJob], {
    isProcessAlive: () => false,
    writeJobFile: () => {
      writeAttempts += 1;
      throw new Error("simulated job-file write failure");
    }
  });

  // Without this the test would still pass if the write were skipped entirely.
  assert.equal(writeAttempts, 1);
  assert.equal(job.status, "failed");
  assert.equal(job.phase, "failed");
  assert.equal(job.pid, null);
  assert.equal(job.reaped, true);
  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === jobId);
  assert.equal(indexedJob.status, "failed");
  assert.equal(indexedJob.phase, "failed");
  assert.equal(indexedJob.pid, null);
  assert.equal(indexedJob.reaped, true);
  assert.equal(fs.readFileSync(jobFile, "utf8"), storedBefore);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "running");
});

test("resolveCancelableJob reports an in-memory reap when the stored job file cannot be read", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const jobId = "task-read-failure";
  const jobFile = resolveJobFile(workspace, jobId);
  const job = {
    id: jobId,
    status: "running",
    pid: 1234
  };
  // A directory at the job-file path makes readStoredJob throw, exercising the stored-file read failure branch.
  fs.mkdirSync(jobFile);
  upsertJob(workspace, job);

  const resolution = resolveCancelableJob(workspace, jobId, { isProcessAlive: () => false });
  const reapedJob = resolution.job;

  assert.equal(resolution.outcome, "reaped");
  assert.equal(reapedJob.status, "failed");
  assert.equal(reapedJob.reaped, true);
  assert.equal(fs.statSync(jobFile).isDirectory(), true);
  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === jobId);
  assert.equal(indexedJob.status, "failed");
  assert.equal(indexedJob.reaped, true);
});

test("resolveCancelableJob reports persistence failure when lock and both reap stores fail", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const jobId = "task-persistence-failure";
  const job = {
    id: jobId,
    status: "running",
    pid: 1234
  };
  upsertJob(workspace, job);

  const jobsDir = resolveJobsDir(workspace);
  fs.rmSync(jobsDir, { recursive: true, force: true });
  fs.writeFileSync(jobsDir, "not a directory", "utf8");

  assert.throws(
    () => resolveCancelableJob(workspace, jobId, { isProcessAlive: () => false }),
    /was reaped in memory but its failed state could not be persisted\./
  );
  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === jobId);
  assert.equal(indexedJob.status, "running");
  assert.equal(indexedJob.pid, job.pid);
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

test("reapDeadJobs preserves a newer active worker published during the dead-process probe", () => {
  const workspace = makeTempDir();
  const jobId = "task-reap-fresh-worker";
  const listedJob = {
    id: jobId,
    workspaceRoot: workspace,
    status: "running",
    phase: "tool",
    pid: 1234,
    pidStartTime: "old-start",
    threadId: "old-thread"
  };
  const freshJob = {
    ...listedJob,
    pid: 5678,
    pidStartTime: "new-start",
    threadId: "new-thread"
  };
  writeJobFile(workspace, jobId, listedJob);
  upsertJob(workspace, listedJob);

  const [job] = reapDeadJobs(workspace, [listedJob], {
    isProcessAlive(pid) {
      assert.equal(pid, listedJob.pid);
      writeJobFile(workspace, jobId, freshJob);
      upsertJob(workspace, freshJob);
      return false;
    }
  });

  assert.equal(job.status, "running");
  assert.equal(job.pid, freshJob.pid);
  assert.equal(job.pidStartTime, freshJob.pidStartTime);
  assert.equal(job.threadId, freshJob.threadId);
  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === jobId);
  assert.equal(indexedJob.status, "running");
  assert.equal(indexedJob.pid, freshJob.pid);
  assert.equal(indexedJob.pidStartTime, freshJob.pidStartTime);
  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(storedJob.status, "running");
  assert.equal(storedJob.pid, freshJob.pid);
  assert.equal(storedJob.pidStartTime, freshJob.pidStartTime);
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

test("runTrackedJob cannot overwrite cancellation that lands before result persistence", async () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-race";
  const job = {
    id: jobId,
    workspaceRoot: workspace,
    title: "Codex Task",
    status: "running"
  };
  let cancellationPersisted = false;

  await runTrackedJob(
    job,
    async () => ({
      exitStatus: 0,
      threadId: "thread-result",
      turnId: "turn-result",
      payload: { result: "done" },
      rendered: "done",
      summary: "done"
    }),
    {
      getProcessStartTime: () => null,
      beforeTerminalPersistence() {
        // This runs after the worker's last pre-write guard and before its persistence lock.
        withJobPersistenceLock(workspace, jobId, () => {
          const cancelledAt = "2026-07-29T12:00:00.000Z";
          writeJobFile(workspace, jobId, {
            ...job,
            status: "cancelled",
            phase: "cancelled",
            pid: null,
            completedAt: cancelledAt,
            cancelledAt,
            errorMessage: "Cancelled by user."
          });
          upsertJob(workspace, {
            id: jobId,
            status: "cancelled",
            phase: "cancelled",
            pid: null,
            completedAt: cancelledAt,
            errorMessage: "Cancelled by user."
          });
        });
        cancellationPersisted = true;
      }
    }
  );

  assert.equal(cancellationPersisted, true);
  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === jobId);
  assert.equal(indexedJob.status, "cancelled");
  assert.equal(indexedJob.phase, "cancelled");
  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(storedJob.status, "cancelled");
  assert.equal(storedJob.phase, "cancelled");
});

test("persistJobCancellation preserves a terminal result that wins after the active snapshot", () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-after-finish";
  const job = {
    id: jobId,
    workspaceRoot: workspace,
    title: "Codex Task",
    status: "running",
    phase: "running",
    pid: 1234
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);
  const completedAt = "2026-07-29T12:01:00.000Z";
  const completedJob = {
    ...job,
    status: "completed",
    phase: "done",
    pid: null,
    completedAt,
    result: { message: "done" }
  };
  const result = persistJobCancellation(workspace, job, {
    withPersistenceLock(cwd, id, callback) {
      return withJobPersistenceLock(cwd, id, () => {
        writeJobFile(cwd, id, completedJob);
        upsertJob(cwd, {
          id,
          status: completedJob.status,
          phase: completedJob.phase,
          pid: completedJob.pid,
          completedAt
        });
        return callback();
      });
    }
  });

  assert.equal(result.cancelled, false);
  assert.equal(result.job.status, "completed");
  assert.equal(result.job.phase, "done");
  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === jobId);
  assert.equal(indexedJob.status, "completed");
  assert.equal(indexedJob.phase, "done");
  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(storedJob.status, "completed");
  assert.equal(storedJob.phase, "done");
});

test("persistJobCancellation uses the freshest stored and indexed metadata", () => {
  const workspace = makeTempDir();
  const jobId = "task-cancel-fresh-metadata";
  const oldLogFile = resolveJobLogFile(workspace, `${jobId}-old`);
  const freshLogFile = resolveJobLogFile(workspace, `${jobId}-fresh`);
  const job = {
    id: jobId,
    workspaceRoot: workspace,
    title: "Codex Task",
    status: "running",
    phase: "running",
    pid: 1234,
    pidStartTime: "old-start",
    threadId: "old-thread",
    turnId: "old-turn",
    logFile: oldLogFile
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);
  const freshStoredJob = {
    ...job,
    title: "Fresh Codex Task",
    phase: "tool",
    pid: 5678,
    pidStartTime: "new-start",
    threadId: "new-thread",
    turnId: "new-turn",
    logFile: freshLogFile,
    storedOnly: "from-job-file"
  };
  const result = persistJobCancellation(workspace, job, {
    withPersistenceLock(cwd, id, callback) {
      return withJobPersistenceLock(cwd, id, () => {
        writeJobFile(cwd, id, freshStoredJob);
        upsertJob(cwd, {
          id,
          status: "running",
          phase: "tool",
          pid: 5678,
          pidStartTime: "indexed-start",
          threadId: "indexed-thread",
          turnId: "indexed-turn",
          summary: "from-index",
          indexedOnly: "from-index"
        });
        return callback();
      });
    }
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.activeJob.pid, 5678);
  assert.equal(result.activeJob.pidStartTime, "new-start");
  assert.equal(result.activeJob.threadId, "new-thread");
  assert.equal(result.activeJob.turnId, "new-turn");
  assert.equal(result.activeJob.logFile, freshLogFile);
  assert.equal(result.activeJob.storedOnly, "from-job-file");
  assert.equal(result.activeJob.summary, "from-index");
  assert.equal(result.activeJob.indexedOnly, "from-index");

  const indexedJob = listJobs(workspace).find((candidate) => candidate.id === jobId);
  assert.equal(indexedJob.status, "cancelled");
  assert.equal(indexedJob.pid, null);
  assert.equal(indexedJob.threadId, "new-thread");
  assert.equal(indexedJob.turnId, "new-turn");
  assert.equal(indexedJob.logFile, freshLogFile);
  assert.equal(indexedJob.storedOnly, "from-job-file");
  assert.equal(indexedJob.summary, "from-index");
  assert.equal(indexedJob.indexedOnly, "from-index");

  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(storedJob.status, "cancelled");
  assert.equal(storedJob.pid, null);
  assert.equal(storedJob.pidStartTime, "new-start");
  assert.equal(storedJob.threadId, "new-thread");
  assert.equal(storedJob.turnId, "new-turn");
  assert.equal(storedJob.logFile, freshLogFile);
  assert.equal(storedJob.storedOnly, "from-job-file");
  assert.equal(storedJob.summary, "from-index");
  assert.equal(storedJob.indexedOnly, "from-index");
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

test("resolveCancelableJob reports an already-reaped terminal job from the job file", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  const jobId = "task-stale-reap";
  const deadPid = spawnDeadPid();
  const logFile = resolveJobLogFile(workspace, jobId);
  const terminalJob = {
    id: jobId,
    status: "failed",
    phase: "failed",
    title: "Already Reaped Task",
    pid: null,
    logFile,
    errorMessage: `Worker process ${deadPid} is no longer running; the job ended without recording a result.`,
    completedAt: "2026-07-29T12:00:00.000Z",
    reaped: true
  };

  writeJobFile(workspace, jobId, terminalJob);
  upsertJob(workspace, {
    id: jobId,
    status: "running",
    title: terminalJob.title,
    pid: deadPid,
    logFile
  });

  const resolution = resolveCancelableJob(workspace, jobId, { isProcessAlive: () => false });
  assert.equal(resolution.outcome, "reaped");
  assert.deepEqual(resolution.job, terminalJob);
  assert.deepEqual(JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8")), terminalJob);
  const indexedJob = listJobs(workspace).find((job) => job.id === jobId);
  assert.equal(indexedJob.status, "running");
  assert.equal(indexedJob.pid, deadPid);
});

test("resolveResultJob reports an explicitly referenced active job", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  upsertJob(workspace, {
    id: "task-still-running",
    status: "running",
    pid: null
  });

  assert.throws(
    () => resolveResultJob(workspace, "task-still-running"),
    /Job task-still-running is still running\./
  );
});

test("resolveResultJob reports the active job when no reference is supplied", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);
  upsertJob(workspace, {
    id: "task-default-running",
    status: "running",
    pid: null
  });

  assert.throws(
    () => resolveResultJob(workspace, ""),
    /Job task-default-running is still running\./
  );
});

test("resolveResultJob reports when no finished job exists without a reference", () => {
  const workspace = makeTempDir();
  ensureStateDir(workspace);

  assert.throws(
    () => resolveResultJob(workspace, ""),
    /No finished Codex jobs found for this repository yet\./
  );
  assert.throws(
    () => resolveResultJob(workspace, "missing-job"),
    /No finished job found for "missing-job"\./
  );
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
