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

const promptLikeConfig = {
  ...taskLikeConfig,
  booleanOptions: [...taskLikeConfig.booleanOptions, "wait"],
  stopAtFirstPositional: true
};

test("stopAtFirstPositional: prose after the first positional is literal, not flag-parsed", () => {
  const { options, positionals } = parseArgs(
    ["--write", "fix", "the", "--wait", "bug"],
    promptLikeConfig
  );

  assert.equal(options.write, true);
  assert.equal(options.wait, undefined);
  assert.deepEqual(positionals, ["fix", "the", "--wait", "bug"]);
  assert.equal(positionals.join(" "), "fix the --wait bug");
});

test("stopAtFirstPositional: a declared value option after the first positional is also literal", () => {
  const { options, positionals } = parseArgs(
    ["--write", "fix", "the", "--model", "thing"],
    promptLikeConfig
  );

  assert.equal(options.write, true);
  assert.equal(options.model, undefined);
  assert.deepEqual(positionals, ["fix", "the", "--model", "thing"]);
});

test("stopAtFirstPositional: an unknown flag before the first positional still throws (issue #46)", () => {
  assert.throws(
    () => parseArgs(["--wat", "do", "the", "thing"], promptLikeConfig),
    /Unknown option: --wat\. Pass literal text after a bare "--" if it is not a flag\./
  );
});

test("default (stopAtFirstPositional: false) behavior is unchanged for the status shape", () => {
  const { options, positionals } = parseArgs(["task-abc", "--wait"], {
    ...taskLikeConfig,
    booleanOptions: [...taskLikeConfig.booleanOptions, "wait"]
  });

  assert.equal(options.wait, true);
  assert.deepEqual(positionals, ["task-abc"]);
});
