import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "check-plugin-version-bump.mjs");

function writeFile(root, file, contents) {
  const filePath = path.join(root, file);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeJson(root, file, json) {
  writeFile(root, file, `${JSON.stringify(json, null, 2)}\n`);
}

function writeVersionFiles(root, version) {
  writeJson(root, "plugins/codex/.claude-plugin/plugin.json", {
    name: "codex",
    version
  });
  writeJson(root, ".claude-plugin/marketplace.json", {
    metadata: {
      version
    },
    plugins: [
      {
        name: "codex",
        version
      }
    ]
  });
}

function commitAll(root, message) {
  assert.equal(run("git", ["add", "."], { cwd: root }).status, 0);
  assert.equal(run("git", ["commit", "-m", message], { cwd: root }).status, 0);
  return run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
}

function makeRepo() {
  const root = makeTempDir();
  initGitRepo(root);
  writeVersionFiles(root, "1.0.0");
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('base');\n");
  const base = commitAll(root, "base");
  return { base, root };
}

test("passes when plugin source changes include plugin and marketplace version bumps", () => {
  const { base, root } = makeRepo();
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('changed');\n");
  writeVersionFiles(root, "1.0.1");
  commitAll(root, "change plugin source with version bump");

  const result = run("node", [SCRIPT, "--root", root, "--base", base], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin source changes include version bumps to 1\.0\.1/);
});

test("fails when the base branch already publishes the bumped version with different plugin source", () => {
  const { base, root } = makeRepo();

  assert.equal(run("git", ["checkout", "-b", "pr-a", base], { cwd: root }).status, 0);
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('change from pr-a');\n");
  writeVersionFiles(root, "1.0.1");
  const prA = commitAll(root, "change plugin source in pr-a");

  assert.equal(run("git", ["checkout", "-b", "pr-b", base], { cwd: root }).status, 0);
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('change from pr-b');\n");
  writeVersionFiles(root, "1.0.1");
  commitAll(root, "change plugin source in pr-b");

  assert.equal(run("git", ["checkout", "main"], { cwd: root }).status, 0);
  assert.equal(run("git", ["merge", "--ff-only", prA], { cwd: root }).status, 0);

  const withoutBaseTip = run("node", [SCRIPT, "--root", root, "--base", base, "--head", "pr-b"], {
    cwd: ROOT
  });
  assert.equal(withoutBaseTip.status, 0, withoutBaseTip.stderr);

  const withBaseTip = run("node", [
    SCRIPT,
    "--root",
    root,
    "--base",
    base,
    "--base-tip",
    "main",
    "--head",
    "pr-b"
  ], { cwd: ROOT });

  assert.notEqual(withBaseTip.status, 0);
  assert.match(withBaseTip.stderr, /Version collision/);
  assert.match(withBaseTip.stderr, /base branch already publishes version 1\.0\.1 with different plugin source/);
  assert.match(withBaseTip.stderr, /plugins\/codex\/scripts\/codex-companion\.mjs/);
});

test("passes when the base branch moved to a different version", () => {
  const { base, root } = makeRepo();

  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('base branch change');\n");
  writeVersionFiles(root, "1.0.1");
  commitAll(root, "move main to 1.0.1");

  assert.equal(run("git", ["checkout", "-b", "pr-head", base], { cwd: root }).status, 0);
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('head branch change');\n");
  writeVersionFiles(root, "1.0.2");
  commitAll(root, "bump head to 1.0.2");

  const result = run("node", [
    SCRIPT,
    "--root",
    root,
    "--base",
    base,
    "--base-tip",
    "main",
    "--head",
    "pr-head"
  ], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin source changes include version bumps to 1\.0\.2/);
});

test("passes when the head plugin source is already contained in the base branch tip", () => {
  const { base, root } = makeRepo();
  const sharedSource = "console.log('shared change');\n";

  assert.equal(run("git", ["checkout", "-b", "pr-head", base], { cwd: root }).status, 0);
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", sharedSource);
  writeVersionFiles(root, "1.0.1");
  commitAll(root, "bump head to 1.0.1");

  assert.equal(run("git", ["checkout", "main"], { cwd: root }).status, 0);
  assert.equal(run("git", ["merge", "--ff-only", "pr-head"], { cwd: root }).status, 0);

  const result = run("node", [
    SCRIPT,
    "--root",
    root,
    "--base",
    base,
    "--base-tip",
    "main",
    "--head",
    "pr-head"
  ], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin source changes include version bumps to 1\.0\.1/);
});

test("passes for non-plugin changes with a same-version base branch tip", () => {
  const { base, root } = makeRepo();

  assert.equal(run("git", ["checkout", "-b", "pr-docs", base], { cwd: root }).status, 0);
  writeFile(root, "README.md", "documentation change\n");
  commitAll(root, "change documentation");

  const result = run("node", [
    SCRIPT,
    "--root",
    root,
    "--base",
    base,
    "--base-tip",
    "main",
    "--head",
    "pr-docs"
  ], { cwd: ROOT });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No plugin source changes found/);
});

test("fails loudly when the base branch tip cannot be resolved", () => {
  const { base, root } = makeRepo();
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('changed');\n");
  writeVersionFiles(root, "1.0.1");
  commitAll(root, "change plugin source with version bump");

  const result = run("node", [
    SCRIPT,
    "--root",
    root,
    "--base",
    base,
    "--base-tip",
    "does-not-exist"
  ], { cwd: ROOT });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fatal: Needed a single revision/);
});

test("fails when plugin source changes without version bumps", () => {
  const { base, root } = makeRepo();
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('changed');\n");
  commitAll(root, "change plugin source");

  const result = run("node", [SCRIPT, "--root", root, "--base", base], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Plugin source changed without the required version bump/);
  assert.match(result.stderr, /plugins\/codex\/\.claude-plugin\/plugin\.json version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json metadata\.version/);
  assert.match(result.stderr, /\.claude-plugin\/marketplace\.json plugins\[codex\]\.version/);
});

test("fails when plugin source files are deleted without version bumps", () => {
  const { base, root } = makeRepo();
  fs.rmSync(path.join(root, "plugins/codex/scripts/codex-companion.mjs"));
  commitAll(root, "delete plugin source");

  const result = run("node", [SCRIPT, "--root", root, "--base", base], {
    cwd: ROOT
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugins\/codex\/scripts\/codex-companion\.mjs/);
  assert.match(result.stderr, /plugins\/codex\/\.claude-plugin\/plugin\.json version/);
});

test("does not require a version bump for manifest-only changes", () => {
  const { base, root } = makeRepo();
  writeVersionFiles(root, "1.0.1");
  commitAll(root, "bump version only");

  const result = run("node", [SCRIPT, "--root", root, "--base", base], {
    cwd: ROOT
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No plugin source changes found/);
});
