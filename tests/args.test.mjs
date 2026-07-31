import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";

const taskLikeConfig = {
  valueOptions: ["cwd", "model", "effort", "resume-id"],
  booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
  aliasMap: { C: "cwd" }
};

test("unrecognized long flag throws instead of landing in positionals (issue #46 repro)", () => {
  assert.throws(
    () =>
      parseArgs(
        ["-C", "/tmp", "--wait", "--write", "--fresh", "--json", "do the thing"],
        taskLikeConfig
      ),
    /Unknown option: --wait\. Pass literal text after a bare "--" if it is not a flag\./
  );
});

test("unrecognized short flag throws", () => {
  assert.throws(
    () => parseArgs(["-x"], taskLikeConfig),
    /Unknown option: -x\. Pass literal text after a bare "--" if it is not a flag\./
  );
});

test("declared booleans, --key=value, value options, and aliases still parse", () => {
  const { options, positionals } = parseArgs(
    ["-C", "/tmp", "--write", "--json=false", "--model", "gpt-5.6-luna", "prompt text"],
    taskLikeConfig
  );

  assert.equal(options.cwd, "/tmp");
  assert.equal(options.write, true);
  assert.equal(options.json, false);
  assert.equal(options.model, "gpt-5.6-luna");
  assert.deepEqual(positionals, ["prompt text"]);
});

test("-- passthrough lets --wait through as a literal positional", () => {
  const { options, positionals } = parseArgs(["--write", "--", "--wait", "do the thing"], taskLikeConfig);

  assert.equal(options.write, true);
  assert.deepEqual(positionals, ["--wait", "do the thing"]);
});

test("bare - is still a positional", () => {
  const { positionals } = parseArgs(["-"], taskLikeConfig);
  assert.deepEqual(positionals, ["-"]);
});

test("missing value for a declared value option still throws", () => {
  assert.throws(() => parseArgs(["--model"], taskLikeConfig), /Missing value for --model/);
  assert.throws(() => parseArgs(["-C"], taskLikeConfig), /Missing value for -C/);
});
