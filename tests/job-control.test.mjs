import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { reapDeadJobs, resolveResultJob } from "../plugins/codex/scripts/lib/job-control.mjs";
import { ensureStateDir, listJobs, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
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
