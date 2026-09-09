import fs from "node:fs";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { run } from "./helpers.mjs";

const HELPERS_URL = new URL("./helpers.mjs", import.meta.url).href;
const CHILD_SOURCE = `import { makeTempDir } from ${JSON.stringify(HELPERS_URL)}; console.log(makeTempDir());`;

function assertChildSucceeded(result) {
  const message = result.error?.message ?? result.stderr.trim();
  assert.equal(
    result.status,
    0,
    message || `Child exited with status ${result.status}.`
  );
}

test("makeTempDir removes its directory when the child exits", () => {
  const env = { ...process.env };
  delete env.CODEX_PLUGIN_TEST_KEEP_TMPDIR;
  const result = run(process.execPath, ["--input-type=module", "-e", CHILD_SOURCE], { env });
  assertChildSucceeded(result);

  const dir = result.stdout.trim();
  assert.notEqual(dir, "");
  assert.equal(fs.existsSync(dir), false);
});

test("makeTempDir keeps its directory when opted out", () => {
  const result = run(process.execPath, ["--input-type=module", "-e", CHILD_SOURCE], {
    env: { ...process.env, CODEX_PLUGIN_TEST_KEEP_TMPDIR: "1" }
  });
  const dir = result.stdout.trim();

  try {
    assertChildSucceeded(result);
    assert.notEqual(dir, "");
    assert.equal(fs.existsSync(dir), true);
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});
