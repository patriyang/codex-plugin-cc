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

test("default mode parses trailing flags after a multi-element prompt", () => {
  const { literalOptionLikePositionals, options, positionals } = parseArgs(
    ["do the thing", "--json"],
    taskLikeConfig
  );

  assert.equal(options.json, true);
  assert.deepEqual(positionals, ["do the thing"]);
  assert.deepEqual(literalOptionLikePositionals, []);
});

test("default mode applies a trailing cwd option after a multi-element prompt", () => {
  const { options, positionals } = parseArgs(["do the thing", "-C", "/tmp"], taskLikeConfig);

  assert.equal(options.cwd, "/tmp");
  assert.deepEqual(positionals, ["do the thing"]);
});

test("literalOptionLikePositionals: reports a declared flag that is the LAST positional (issue #46 round 2)", () => {
  const { literalOptionLikePositionals } = parseArgs(
    ["do", "the", "thing", "--wait"],
    promptLikeConfig
  );

  assert.deepEqual(literalOptionLikePositionals, ["--wait"]);
});

test("literalOptionLikePositionals: empty for a non-declared token at the tail", () => {
  const { literalOptionLikePositionals, positionals } = parseArgs(
    ["do", "the", "thing", "--dry-run"],
    promptLikeConfig
  );

  assert.deepEqual(literalOptionLikePositionals, []);
  assert.deepEqual(positionals, ["do", "the", "thing", "--dry-run"]);
});

test("literalOptionLikePositionals: empty for a declared flag buried mid-prose, not at the tail (round 2 fix)", () => {
  // "fix the --wait bug" -- --wait is a real, declared boolean option on the
  // handler, but it is not the last (or second-to-last) positional, so this
  // is prose mentioning a flag name, not a forgotten flag. Must not warn.
  const { literalOptionLikePositionals, positionals } = parseArgs(
    ["fix", "the", "--wait", "bug"],
    promptLikeConfig
  );

  assert.deepEqual(literalOptionLikePositionals, []);
  assert.deepEqual(positionals, ["fix", "the", "--wait", "bug"]);
});

test("literalOptionLikePositionals: reports a trailing declared *value* option paired with its trailing value (round 2 fix)", () => {
  // "do the thing -C /tmp" -- -C is second-to-last and is a declared value
  // option; /tmp (the last positional) is its would-be value. Must warn on
  // -C, not on /tmp.
  const { literalOptionLikePositionals, positionals } = parseArgs(
    ["do", "the", "thing", "-C", "/tmp"],
    promptLikeConfig
  );

  assert.deepEqual(literalOptionLikePositionals, ["-C"]);
  assert.deepEqual(positionals, ["do", "the", "thing", "-C", "/tmp"]);
});

test("literalOptionLikePositionals: a trailing declared *boolean* option second-to-last does not pair with the next token", () => {
  // "do the thing --write extra" -- --write is second-to-last but it is a
  // boolean option, not a value option, so it does not consume "extra" as a
  // value; "extra" itself is not option-like either. Nothing to warn about.
  const { literalOptionLikePositionals, positionals } = parseArgs(
    ["do", "the", "thing", "--write", "extra"],
    promptLikeConfig
  );

  assert.deepEqual(literalOptionLikePositionals, []);
  assert.deepEqual(positionals, ["do", "the", "thing", "--write", "extra"]);
});

test("literalOptionLikePositionals: empty for tokens after an explicit bare --", () => {
  const { literalOptionLikePositionals, positionals } = parseArgs(
    ["--write", "--", "--wait", "do the thing"],
    promptLikeConfig
  );

  assert.deepEqual(literalOptionLikePositionals, []);
  assert.deepEqual(positionals, ["--wait", "do the thing"]);
});

test("literalOptionLikePositionals: empty for tokens after a bare -- following the first positional", () => {
  const { literalOptionLikePositionals, positionals } = parseArgs(
    ["do", "the", "thing", "--", "--json"],
    promptLikeConfig
  );
  const withoutEscapeHatch = parseArgs(["do", "the", "thing", "--json"], promptLikeConfig);

  assert.deepEqual(literalOptionLikePositionals, []);
  assert.deepEqual(positionals, ["do", "the", "thing", "--", "--json"]);
  assert.deepEqual(withoutEscapeHatch.literalOptionLikePositionals, ["--json"]);
});

test("literalOptionLikePositionals: empty in default (non-stopAtFirstPositional) mode", () => {
  const { literalOptionLikePositionals, options, positionals } = parseArgs(
    ["task-abc", "--wait"],
    { ...taskLikeConfig, booleanOptions: [...taskLikeConfig.booleanOptions, "wait"] }
  );

  // Without stopAtFirstPositional, "--wait" after the positional is parsed
  // as a real flag (not literal text), so there is nothing to warn about.
  assert.equal(options.wait, true);
  assert.deepEqual(positionals, ["task-abc"]);
  assert.deepEqual(literalOptionLikePositionals, []);
});

test("literalOptionLikePositionals: reports every flag in a trailing run, not just the first", () => {
  const { literalOptionLikePositionals, positionals } = parseArgs(
    ["do the thing", "-C", "/tmp", "--json"],
    promptLikeConfig
  );

  // Reporting only --json would make the caller fix it, re-run, and be told
  // about -C -- the one that silently sent the run to the wrong workspace.
  assert.deepEqual(literalOptionLikePositionals, ["-C", "--json"]);
  assert.equal(positionals.join(" "), "do the thing -C /tmp --json");
});

test("literalOptionLikePositionals: a trailing run of value options reports each one", () => {
  const { literalOptionLikePositionals } = parseArgs(
    ["do the thing", "--model", "spark", "--effort", "high"],
    promptLikeConfig
  );

  assert.deepEqual(literalOptionLikePositionals, ["--model", "--effort"]);
});

test("literalOptionLikePositionals: the leftward walk stops at real prose", () => {
  const { literalOptionLikePositionals } = parseArgs(
    ["fix", "the", "--wait", "bug", "--json"],
    promptLikeConfig
  );

  // --json trails, but --wait is separated from it by the word "bug", so the
  // walk stops and the mid-prose mention stays quiet.
  assert.deepEqual(literalOptionLikePositionals, ["--json"]);
});
