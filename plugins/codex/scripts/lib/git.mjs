import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const HASH_OBJECT_MAX_BATCH_PATHS = 256;
// Keep argv well below Windows' command-line limit, including fixed arguments and quoting.
const HASH_OBJECT_MAX_BATCH_ARG_BYTES = 8 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function gitNullTerminatedPaths(cwd, args) {
  return gitChecked(cwd, [...args, "-z"]).stdout.split("\0").filter(Boolean);
}

function resolveOid(cwd, ref) {
  return gitChecked(cwd, ["rev-parse", ref]).stdout.trim();
}

function tryResolveOid(cwd, ref) {
  const result = git(cwd, ["rev-parse", ref]);
  if (result.error) {
    throw result.error;
  }
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function hashNestedGitRepository(absolutePath) {
  if (!fs.existsSync(path.join(absolutePath, ".git"))) {
    return null;
  }

  const head = git(absolutePath, ["rev-parse", "HEAD"]);
  const status = git(absolutePath, ["status", "--porcelain", "--untracked-files=all"]);
  const stagedDiff = git(absolutePath, ["diff", "--cached", "--binary", "--no-ext-diff"]);
  const unstagedDiff = git(absolutePath, ["diff", "--binary", "--no-ext-diff"]);
  if (
    head.error || head.status !== 0 ||
    status.error || status.status !== 0 ||
    stagedDiff.error || stagedDiff.status !== 0 ||
    unstagedDiff.error || unstagedDiff.status !== 0
  ) {
    return null;
  }

  const statusDigest = createHash("sha256").update(status.stdout).digest("hex");
  const stagedDiffDigest = createHash("sha256").update(stagedDiff.stdout).digest("hex");
  const unstagedDiffDigest = createHash("sha256").update(unstagedDiff.stdout).digest("hex");
  return `submodule:${head.stdout.trim()}:${statusDigest}:${stagedDiffDigest}:${unstagedDiffDigest}`;
}

function classifyPath(cwd, relativePath, missingToken, nonRegularToken) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return { type: "token", token: missingToken };
  }

  if (stat.isFile()) {
    return { type: "regular" };
  }

  return { type: "token", token: nonRegularToken(stat, absolutePath) };
}

function classifyWorkingTreePath(cwd, relativePath) {
  return classifyPath(cwd, relativePath, "missing", (stat, absolutePath) => {
    if (stat.isSymbolicLink()) {
      return `symlink:${createHash("sha256").update(fs.readlinkSync(absolutePath)).digest("hex")}`;
    }
    if (stat.isDirectory()) {
      return hashNestedGitRepository(absolutePath) ?? `other:${stat.mode}:${stat.size}`;
    }
    return `other:${stat.mode}:${stat.size}`;
  });
}

function inspectUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { skip: "(skipped: broken symlink or unreadable file)" };
  }

  if (stat.isDirectory()) {
    return { skip: "(skipped: directory)" };
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return { skip: `(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)` };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return { skip: "(skipped: broken symlink or unreadable file)" };
  }
  if (!isProbablyText(buffer)) {
    return { skip: "(skipped: binary file)" };
  }

  return { content: buffer.toString("utf8").trimEnd() };
}

function classifyUntrackedPath(cwd, relativePath) {
  return classifyPath(
    cwd,
    relativePath,
    "skipped:(skipped: broken symlink or unreadable file)",
    () => {
      // Preserve the existing handling for symlinks, directories, and other
      // non-regular paths. Display limits must not affect regular-file identity.
      const inspected = inspectUntrackedFile(cwd, relativePath);
      if (inspected.skip) {
        return `skipped:${inspected.skip}`;
      }
      return `file:${createHash("sha256").update(inspected.content).digest("hex")}`;
    }
  );
}

function hashRegularFile(cwd, relativePath, failureResults) {
  const result = git(cwd, ["hash-object", "--no-filters", "--", relativePath]);
  if (result.error || result.status !== 0) {
    failureResults.set(relativePath, result);
    return null;
  }
  return result.stdout.trim();
}

function hashRegularFilesBatched(cwd, relativePaths, failureResults) {
  const hashes = new Map();

  for (let offset = 0; offset < relativePaths.length;) {
    const chunk = [];
    let chunkBytes = 0;
    while (offset < relativePaths.length && chunk.length < HASH_OBJECT_MAX_BATCH_PATHS) {
      const relativePath = relativePaths[offset];
      const pathBytes = Buffer.byteLength(relativePath, "utf8");
      if (chunk.length > 0 && chunkBytes + pathBytes > HASH_OBJECT_MAX_BATCH_ARG_BYTES) {
        break;
      }
      chunk.push(relativePath);
      chunkBytes += pathBytes;
      offset += 1;
    }

    const result = git(cwd, ["hash-object", "--no-filters", "--", ...chunk]);
    const oids = !result.error && result.status === 0
      ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [];
    if (!result.error && result.status === 0 && oids.length === chunk.length) {
      chunk.forEach((relativePath, index) => hashes.set(relativePath, oids[index]));
      continue;
    }

    for (const relativePath of chunk) {
      hashes.set(relativePath, hashRegularFile(cwd, relativePath, failureResults));
    }
  }

  return hashes;
}

function captureWorkingTreeDigest(cwd) {
  const digest = createHash("sha256");
  const status = gitChecked(cwd, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]).stdout;
  digest.update(status);

  // Porcelain v2 records tracked object IDs, but not an OID for unstaged
  // working-tree content. Fold dirty tracked paths in so repeated edits cannot
  // resolve to the same identity.
  const trackedPaths = listUniqueFiles(gitNullTerminatedPaths(cwd, ["diff", "--name-only"]));
  const trackedClassifications = trackedPaths.map((relativePath) => ({
    relativePath,
    classification: classifyWorkingTreePath(cwd, relativePath)
  }));

  const untrackedPaths = gitNullTerminatedPaths(cwd, ["ls-files", "--others", "--exclude-standard"]).sort();
  const untrackedClassifications = untrackedPaths.map((relativePath) => ({
    relativePath,
    classification: classifyUntrackedPath(cwd, relativePath)
  }));

  const regularPaths = [...trackedClassifications, ...untrackedClassifications]
    .filter(({ classification }) => classification.type === "regular")
    .map(({ relativePath }) => relativePath);
  const hashFailures = new Map();
  const hashes = hashRegularFilesBatched(cwd, regularPaths, hashFailures);

  for (const { relativePath, classification } of trackedClassifications) {
    let token = classification.token;
    if (classification.type === "regular") {
      const oid = hashes.get(relativePath);
      if (oid === null) {
        const failure = hashFailures.get(relativePath);
        if (failure.error) {
          throw failure.error;
        }
        throw new Error(formatCommandFailure(failure));
      }
      token = `file:${oid}`;
    }
    digest.update(`\0tracked\0${relativePath}\0${token}`);
  }

  for (const { relativePath, classification } of untrackedClassifications) {
    let token = classification.token;
    if (classification.type === "regular") {
      const oid = hashes.get(relativePath);
      token = oid === null
        ? "skipped:(skipped: broken symlink or unreadable file)"
        : `file:${oid}`;
    }
    digest.update(`\0untracked\0${relativePath}\0${token}`);
  }

  return digest.digest("hex");
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function resolveWorktreeWritableRoots(cwd) {
  const gitDir = git(cwd, ["rev-parse", "--git-dir"]);
  if (gitDir.error || gitDir.status !== 0) {
    return [];
  }

  const gitCommonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
  if (gitCommonDir.error || gitCommonDir.status !== 0) {
    return [];
  }

  const absoluteGitDir = path.resolve(cwd, gitDir.stdout.trim());
  const absoluteGitCommonDir = path.resolve(cwd, gitCommonDir.stdout.trim());
  if (absoluteGitDir === absoluteGitCommonDir) {
    return [];
  }

  return [absoluteGitCommonDir];
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function captureRepoStateIdentity(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const identity = {
    headOid: resolveOid(repoRoot, "HEAD")
  };

  if (target.mode === "branch") {
    identity.baseOid = resolveOid(repoRoot, target.baseRef);
  } else if (target.mode === "working-tree") {
    identity.worktreeDigest = captureWorkingTreeDigest(repoRoot);
  }

  return identity;
}

export function describeRepoStateDrift(cwd, target, expected) {
  const repoRoot = getRepoRoot(cwd);
  const headOid = tryResolveOid(repoRoot, "HEAD");
  if (!headOid) {
    return "HEAD no longer resolves";
  }
  if (headOid !== expected.headOid) {
    return "HEAD moved";
  }
  if (target.mode === "branch") {
    const baseOid = tryResolveOid(repoRoot, target.baseRef);
    if (!baseOid) {
      return `base ref ${target.baseRef} no longer resolves`;
    }
    if (baseOid !== expected.baseOid) {
      return `base ref ${target.baseRef} moved`;
    }
  }
  if (target.mode === "working-tree" && captureWorkingTreeDigest(repoRoot) !== expected.worktreeDigest) {
    return "working tree moved";
  }
  return null;
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const inspected = inspectUntrackedFile(cwd, relativePath);
  if (inspected.skip) {
    return `### ${relativePath}\n${inspected.skip}`;
  }

  return [`### ${relativePath}`, "```", inspected.content, "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
