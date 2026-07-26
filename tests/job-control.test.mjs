import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { reapDeadJobs } from "../plugins/codex/scripts/lib/job-control.mjs";
import { makeTempDir } from "./helpers.mjs";

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
