import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  captureRepoStateIdentity,
  collectReviewContext,
  describeRepoStateDrift,
  resolveReviewTarget,
  resolveWorktreeWritableRoots
} from "../plugins/codex/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveWorktreeWritableRoots returns the common git dir for linked worktrees only", () => {
  const mainRepo = makeTempDir();
  const worktreeParent = makeTempDir();
  const worktree = path.join(worktreeParent, "linked-worktree");
  const nonGitDir = makeTempDir();

  try {
    initGitRepo(mainRepo);
    fs.writeFileSync(path.join(mainRepo, "app.js"), "console.log('v1');\n");
    run("git", ["add", "app.js"], { cwd: mainRepo });
    run("git", ["commit", "-m", "init"], { cwd: mainRepo });
    run("git", ["worktree", "add", "-b", "linked-test", worktree], { cwd: mainRepo });

    const roots = resolveWorktreeWritableRoots(worktree);

    assert.equal(roots.length, 1);
    assert.equal(fs.realpathSync(roots[0]), fs.realpathSync(path.join(mainRepo, ".git")));
    assert.deepEqual(resolveWorktreeWritableRoots(mainRepo), []);
    assert.deepEqual(resolveWorktreeWritableRoots(nonGitDir), []);
  } finally {
    fs.rmSync(mainRepo, { recursive: true, force: true });
    fs.rmSync(worktreeParent, { recursive: true, force: true });
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("repo state identity reports no drift when a branch target is unchanged", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const identity = captureRepoStateIdentity(cwd, target);

  assert.match(identity.headOid, /^[0-9a-f]{40}$/);
  assert.match(identity.baseOid, /^[0-9a-f]{40}$/);
  assert.equal(describeRepoStateDrift(cwd, target, identity), null);
});

test("repo state identity detects when a branch target's base ref moves", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const identity = captureRepoStateIdentity(cwd, target);
  run("git", ["branch", "-f", "main", "HEAD"], { cwd });

  assert.match(describeRepoStateDrift(cwd, target, identity), /base ref main moved/i);
});

test("repo state identity reports when a branch target's base ref disappears", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  const identity = captureRepoStateIdentity(cwd, target);
  run("git", ["branch", "-D", "main"], { cwd });

  assert.match(describeRepoStateDrift(cwd, target, identity), /base ref main no longer resolves/i);
});

test("repo state identity detects further edits to an already-dirty tracked file", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const identity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v3');\n");

  assert.match(describeRepoStateDrift(cwd, target, identity), /working tree moved/i);
});

test("repo state identity detects changes to an untracked file's contents", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "notes.txt"), "first draft\n");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const identity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(path.join(cwd, "notes.txt"), "second draft\n");

  assert.match(describeRepoStateDrift(cwd, target, identity), /working tree moved/i);
});

test("repo state identity detects changes to an untracked binary file", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "artifact.bin"), Buffer.from([0, 1, 2, 3]));

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const identity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(path.join(cwd, "artifact.bin"), Buffer.from([0, 1, 2, 4]));

  assert.match(describeRepoStateDrift(cwd, target, identity), /working tree moved/i);
});

test("repo state identity detects same-size changes to a large untracked file", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "large.txt"), "a".repeat(25 * 1024));

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const identity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(path.join(cwd, "large.txt"), `${"a".repeat(25 * 1024 - 1)}b`);

  assert.match(describeRepoStateDrift(cwd, target, identity), /working tree moved/i);
});

test("repo state identity detects trailing-newline-only changes to an untracked file", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "notes.txt"), "draft\n");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const identity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(path.join(cwd, "notes.txt"), "draft\n\n");

  assert.match(describeRepoStateDrift(cwd, target, identity), /working tree moved/i);
});

test("repo state identity detects further changes inside a dirty submodule", () => {
  const cwd = makeTempDir();
  const nestedRepo = path.join(cwd, "vendor", "dependency");
  initGitRepo(cwd);
  fs.mkdirSync(nestedRepo, { recursive: true });
  initGitRepo(nestedRepo);
  fs.writeFileSync(path.join(nestedRepo, "version.txt"), "v1\n");
  run("git", ["add", "version.txt"], { cwd: nestedRepo });
  run("git", ["commit", "-m", "dependency v1"], { cwd: nestedRepo });
  run("git", ["add", "vendor/dependency"], { cwd });
  run("git", ["commit", "-m", "track dependency"], { cwd });
  fs.writeFileSync(path.join(nestedRepo, "version.txt"), "v2\n");
  run("git", ["add", "version.txt"], { cwd: nestedRepo });
  run("git", ["commit", "-m", "dependency v2"], { cwd: nestedRepo });

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const identity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(path.join(nestedRepo, "version.txt"), "v3\n");

  assert.match(describeRepoStateDrift(cwd, target, identity), /working tree moved/i);
});

test("repo state identity hashes staged and unstaged diff content inside a dirty submodule", () => {
  const cwd = makeTempDir();
  const nestedRepo = path.join(cwd, "vendor", "dependency");
  initGitRepo(cwd);
  fs.mkdirSync(nestedRepo, { recursive: true });
  initGitRepo(nestedRepo);
  fs.writeFileSync(path.join(nestedRepo, "version.txt"), "v1\n");
  run("git", ["add", "version.txt"], { cwd: nestedRepo });
  run("git", ["commit", "-m", "dependency v1"], { cwd: nestedRepo });
  run("git", ["add", "vendor/dependency"], { cwd });
  run("git", ["commit", "-m", "track dependency"], { cwd });

  fs.writeFileSync(path.join(nestedRepo, "version.txt"), "v2 unstaged\n");
  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const unstagedIdentity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(path.join(nestedRepo, "version.txt"), "v3 unstaged\n");
  assert.match(describeRepoStateDrift(cwd, target, unstagedIdentity), /working tree moved/i);

  run("git", ["add", "version.txt"], { cwd: nestedRepo });
  run("git", ["commit", "-m", "dependency v3"], { cwd: nestedRepo });
  fs.writeFileSync(path.join(nestedRepo, "version.txt"), "v4 staged\n");
  run("git", ["add", "version.txt"], { cwd: nestedRepo });
  const stagedIdentity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(path.join(nestedRepo, "version.txt"), "v5 staged\n");
  run("git", ["add", "version.txt"], { cwd: nestedRepo });
  assert.match(describeRepoStateDrift(cwd, target, stagedIdentity), /working tree moved/i);
});

test("repo state identity detects changes through an untracked symlink", () => {
  const cwd = makeTempDir();
  const outside = makeTempDir();
  const destination = path.join(outside, "notes.txt");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(destination, "first draft\n");
  fs.symlinkSync(destination, path.join(cwd, "linked-notes.txt"));

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const identity = captureRepoStateIdentity(cwd, target);
  fs.writeFileSync(destination, "second draft\n");

  assert.match(describeRepoStateDrift(cwd, target, identity), /working tree moved/i);
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});
