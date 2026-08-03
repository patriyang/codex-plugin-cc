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

test("passes when independent branches produce an identical plugin tree", () => {
  const { base, root } = makeRepo();
  const sharedSource = "console.log('same change');\n";

  assert.equal(run("git", ["checkout", "-b", "pr-a", base], { cwd: root }).status, 0);
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", sharedSource);
  writeVersionFiles(root, "1.0.1");
  const prA = commitAll(root, "bump pr-a to 1.0.1");

  assert.equal(run("git", ["checkout", "-b", "pr-b", base], { cwd: root }).status, 0);
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", sharedSource);
  writeVersionFiles(root, "1.0.1");
  commitAll(root, "bump pr-b to 1.0.1");

  assert.equal(run("git", ["checkout", "main"], { cwd: root }).status, 0);
  assert.equal(run("git", ["merge", "--ff-only", prA], { cwd: root }).status, 0);

  const result = run("node", [
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

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plugin source changes include version bumps to 1\.0\.1/);
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

// See #71. The PR-time gate only runs on `pull_request` events, so two PRs cut
// from the same commit can both go green before either merges, and nothing
// re-checks the loser after the winner lands. The post-merge run on `main` is
// what catches the collision that ships.
test("catches a collision that shipped when the post-merge check runs on main", () => {
  const { base, root } = makeRepo();

  assert.equal(run("git", ["checkout", "-b", "pr-a", base], { cwd: root }).status, 0);
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('change from pr-a');\n");
  writeVersionFiles(root, "1.0.1");
  const prA = commitAll(root, "change plugin source in pr-a");

  assert.equal(run("git", ["checkout", "-b", "pr-b", base], { cwd: root }).status, 0);
  writeFile(root, "plugins/codex/scripts/codex-companion.mjs", "console.log('change from pr-b');\n");
  writeVersionFiles(root, "1.0.1");
  const prB = commitAll(root, "change plugin source in pr-b");

  // Both PRs run CI while main is still at `base`, so neither collides yet.
  assert.equal(run("git", ["checkout", "main"], { cwd: root }).status, 0);
  for (const head of [prA, prB]) {
    const ci = run("node", [SCRIPT, "--root", root, "--base", base, "--base-tip", "main", "--head", head], {
      cwd: ROOT
    });
    assert.equal(ci.status, 0, ci.stderr);
  }

  assert.equal(run("git", ["merge", "--ff-only", prA], { cwd: root }).status, 0);
  const mainAfterA = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

  // B merges on its still-green check; main now publishes 1.0.1 with B's source.
  assert.equal(run("git", ["merge", "-X", "theirs", "--no-ff", "-m", "merge pr-b", prB], { cwd: root }).status, 0);
  const mainAfterB = run("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

  const postMerge = run("node", [SCRIPT, "--root", root, "--base", mainAfterA, "--head", mainAfterB], {
    cwd: ROOT
  });

  assert.notEqual(postMerge.status, 0, "post-merge check must fail on the shipped collision");
  assert.match(postMerge.stderr, /Plugin source changed without the required version bump/);
  assert.match(postMerge.stderr, /plugins\/codex\/scripts\/codex-companion\.mjs/);
});

test("main version guard workflow re-runs the check against the previous main tip", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "main-version-guard.yml"), "utf8");

  // Must fire on pushes to main -- the event the pull_request gate cannot see.
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main/);
  assert.match(workflow, /check-plugin-version-bump/);
  // The comparison that catches the collision: previous main tip -> new main tip.
  assert.match(workflow, /github\.event\.before/);
  assert.match(workflow, /github\.sha/);
  // A first push or a force-push leaves no reachable previous tip; skip instead
  // of failing the guard for a reason unrelated to versioning.
  assert.match(workflow, /0{40}/);
  assert.match(workflow, /rev-parse --verify/);
  // The check needs history on both sides of the comparison.
  assert.match(workflow, /fetch-depth: 0/);
});
