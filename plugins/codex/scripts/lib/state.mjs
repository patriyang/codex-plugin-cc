import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { getProcessStartTime, isProcessAlive } from "./process.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const JOB_LOCK_TIMEOUT_MS = 10000;
const JOB_LOCK_RETRY_MS = 5;

let currentProcessStartTimeResolved = false;
let currentProcessStartTime = null;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function saveState(cwd, state) {
  return withStatePersistenceLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStatePersistenceLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

function resolveStateLockFile(cwd) {
  ensureStateDir(cwd);
  return path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
}

function resolveJobLockFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.lock`);
}

function sleepSynchronously(milliseconds) {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function normalizeLockStartTime(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function resolveCurrentProcessStartTime(options = {}) {
  if (options.getProcessStartTime) {
    try {
      return normalizeLockStartTime(options.getProcessStartTime(process.pid));
    } catch {
      return null;
    }
  }

  if (!currentProcessStartTimeResolved) {
    try {
      const resolved = normalizeLockStartTime(getProcessStartTime(process.pid));
      if (resolved) {
        currentProcessStartTime = resolved;
        currentProcessStartTimeResolved = true;
      }
    } catch {
      // Retry an unavailable lookup on the next lock acquisition.
    }
  }
  return currentProcessStartTime;
}

function createLockOwner(options = {}) {
  return {
    token: randomUUID(),
    pid: process.pid,
    pidStartTime: resolveCurrentProcessStartTime(options)
  };
}

function readLockOwner(lockFile) {
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (!owner || typeof owner.token !== "string" || !owner.token) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function isDefinitelyAbandoned(owner, options = {}) {
  const ownerStartTime = normalizeLockStartTime(owner?.pidStartTime);
  if (!Number.isFinite(owner?.pid) || owner.pid <= 0 || !ownerStartTime) {
    return false;
  }

  const isProcessAliveImpl = options.isProcessAlive ?? isProcessAlive;
  let alive;
  try {
    alive = isProcessAliveImpl(owner.pid);
  } catch {
    return false;
  }
  if (alive === false) {
    return true;
  }
  if (alive !== true) {
    return false;
  }

  const getProcessStartTimeImpl = options.getProcessStartTime ?? getProcessStartTime;
  let currentStartTime;
  try {
    currentStartTime = normalizeLockStartTime(getProcessStartTimeImpl(owner.pid));
  } catch {
    return false;
  }
  return Boolean(currentStartTime) && currentStartTime !== ownerStartTime;
}

function removeLockIfOwned(lockFile, token) {
  const owner = readLockOwner(lockFile);
  if (owner?.token !== token) {
    return false;
  }
  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return false;
    }
    return true;
  }
}

// A missing or ambiguous owner identity is preserved so a live lock is never stolen.
function reclaimAbandonedLock(lockFile, options = {}) {
  const owner = readLockOwner(lockFile);
  if (!isDefinitelyAbandoned(owner, options)) {
    return false;
  }
  return removeLockIfOwned(lockFile, owner.token);
}

function withPersistenceLock(lockFile, callback, options = {}, description = lockFile) {
  const owner = createLockOwner(options);
  const timeoutMs = options.timeoutMs ?? JOB_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? JOB_LOCK_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  let lockHandle = null;

  while (lockHandle === null) {
    try {
      lockHandle = fs.openSync(lockFile, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (reclaimAbandonedLock(lockFile, options)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring persistence lock ${description}.`);
      }
      sleepSynchronously(retryMs);
      continue;
    }

    try {
      fs.writeFileSync(lockHandle, `${JSON.stringify(owner)}\n`, "utf8");
    } catch (error) {
      fs.closeSync(lockHandle);
      lockHandle = null;
      throw error;
    }
  }

  try {
    return callback();
  } finally {
    fs.closeSync(lockHandle);
    removeLockIfOwned(lockFile, owner.token);
  }
}

export function withStatePersistenceLock(cwd, callback, options = {}) {
  return withPersistenceLock(resolveStateLockFile(cwd), callback, options, "for workspace state");
}

export function withJobPersistenceLock(cwd, jobId, callback, options = {}) {
  return withPersistenceLock(resolveJobLockFile(cwd, jobId), callback, options, `for job ${jobId}`);
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
