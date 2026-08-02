import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;
process.env.CLAUDE_PLUGIN_DATA = makeTempDir();

// Several suites poll-read the fixture's state file from the test process while the
// fixture process rewrites it. An in-place `writeFileSync` truncates before writing, so
// a reader that lands inside that window parses a half-written file.
test("fake codex fixture never exposes a half-written state file to a cross-process reader", async (t) => {
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeCodex(binDir);
  const statePath = path.join(binDir, "fake-codex-state.json");

  const child = spawn(path.join(binDir, "codex"), ["app-server"], {
    cwd: repo,
    env: buildEnv(binDir),
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.resume();
  child.stderr.resume();
  // The requests below are queued faster than the fixture drains them, so killing it
  // leaves writes in flight. Their EPIPE lands after the test body returns, where an
  // unhandled one becomes an uncaughtException and fails the file despite a green
  // assertion. Swallow it and wait for the child to actually exit.
  child.stdin.on("error", () => {});
  const childClosed = new Promise((resolve) => child.on("close", resolve));
  t.after(async () => {
    child.kill("SIGKILL");
    await childClosed;
  });

  // Each `thread/start` appends a thread and saves twice, so the file grows as the run
  // proceeds and the truncate-to-rewrite window widens with it.
  for (let index = 0; index < 800; index += 1) {
    child.stdin.write(
      `${JSON.stringify({
        id: index + 1,
        method: "thread/start",
        params: { cwd: repo, ephemeral: false }
      })}\n`
    );
  }

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !fs.existsSync(statePath)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fs.existsSync(statePath), true, "expected the fixture to write its state file");

  const tornReads = [];
  let cleanReads = 0;
  let observedThreads = 0;
  const readDeadline = Date.now() + 3000;
  while (Date.now() < readDeadline && observedThreads < 800) {
    let raw;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch (error) {
      tornReads.push(`read failed: ${error.code ?? error.message}`);
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      cleanReads += 1;
      observedThreads = parsed.threads?.length ?? 0;
    } catch (error) {
      tornReads.push(`${error.message} (${raw.length} bytes)`);
    }
  }

  assert.ok(cleanReads > 0, "expected at least one readable state snapshot");
  assert.deepEqual(
    tornReads.slice(0, 3),
    [],
    `expected no torn reads, saw ${tornReads.length} of ${tornReads.length + cleanReads}`
  );
});
