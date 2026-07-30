import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { getProcessStartTime, isProcessAlive } from "./process.mjs";
import {
  getConfig,
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob,
  withJobPersistenceLock,
  writeJobFile
} from "./state.mjs";
import { appendLogLine, nowIso, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function normalizeJobStartTime(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function hasSameWorkerIdentity(left, right) {
  const leftPid = Number.isFinite(left?.pid) ? left.pid : null;
  const rightPid = Number.isFinite(right?.pid) ? right.pid : null;
  return (
    leftPid === rightPid &&
    normalizeJobStartTime(left?.pidStartTime) === normalizeJobStartTime(right?.pidStartTime)
  );
}

function resolveReapCompletedAt(job, fallback = nowIso()) {
  let completedAt = job.updatedAt ?? fallback;
  try {
    if (job.logFile && fs.existsSync(job.logFile)) {
      const mtime = fs.statSync(job.logFile).mtime;
      const startedAt = Date.parse(job.startedAt ?? "");
      if (Number.isFinite(startedAt) && mtime.getTime() >= startedAt) {
        completedAt = mtime.toISOString();
      }
    }
  } catch {
    // Fall back to the last recorded update time.
  }
  return completedAt;
}

export function persistJobCancellation(workspaceRoot, job, options = {}) {
  const withPersistenceLockImpl = options.withPersistenceLock ?? withJobPersistenceLock;
  let terminalJob = null;
  let cancelledJob = null;
  let activeJob = null;
  let latestJob = null;

  withPersistenceLockImpl(workspaceRoot, job.id, () => {
    const latestStoredJob = readStoredJob(workspaceRoot, job.id);
    const latestIndexedJob = listJobs(workspaceRoot).find((candidate) => candidate.id === job.id) ?? null;
    latestJob = latestStoredJob ?? latestIndexedJob;
    terminalJob = [latestStoredJob, latestIndexedJob].find((candidate) => isTerminalJobStatus(candidate?.status)) ?? null;
    if (terminalJob || ![latestStoredJob, latestIndexedJob].some((candidate) => isActiveJobStatus(candidate?.status))) {
      return;
    }

    activeJob = {
      ...(latestIndexedJob ?? {}),
      ...(latestStoredJob ?? {})
    };
    const completedAt = nowIso();
    cancelledJob = {
      ...activeJob,
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      completedAt,
      errorMessage: "Cancelled by user."
    };
    writeJobFile(workspaceRoot, job.id, {
      ...cancelledJob,
      cancelledAt: completedAt
    });
    upsertJob(workspaceRoot, cancelledJob);
  });

  return {
    cancelled: Boolean(cancelledJob),
    job: terminalJob ?? cancelledJob ?? latestJob,
    activeJob
  };
}

export function reapDeadJobs(workspaceRoot, jobs, options = {}) {
  const isProcessAliveImpl = options.isProcessAlive ?? isProcessAlive;
  const getProcessStartTimeImpl = options.getProcessStartTime ?? getProcessStartTime;

  return jobs.map((job) => {
    if (
      (job.status !== "queued" && job.status !== "running") ||
      !Number.isFinite(job.pid)
    ) {
      return job;
    }

    const probedWorker = {
      pid: job.pid,
      pidStartTime: job.pidStartTime
    };
    try {
      if (isProcessAliveImpl(probedWorker.pid)) {
        const storedStartTime = typeof job.pidStartTime === "string" ? job.pidStartTime.trim() : "";
        if (!storedStartTime) {
          return job;
        }

        const currentStartTime = getProcessStartTimeImpl(probedWorker.pid);
        const normalizedCurrentStartTime =
          typeof currentStartTime === "string" ? currentStartTime.trim() : "";
        if (!normalizedCurrentStartTime || normalizedCurrentStartTime === storedStartTime) {
          return job;
        }
      }
    } catch {
      return job;
    }

    let storedJob = null;
    try {
      storedJob = readStoredJob(workspaceRoot, job.id);
    } catch {
      // Re-read under the persistence lock before deciding whether to reap.
    }

    if (
      storedJob &&
      storedJob.status !== "queued" &&
      storedJob.status !== "running"
    ) {
      return storedJob;
    }

    const currentJob = {
      ...job,
      ...(storedJob ?? {})
    };
    const pid = probedWorker.pid;
    const logFile = currentJob.logFile ?? null;
    const completedAt = resolveReapCompletedAt(currentJob);

    const reapedJob = {
      ...currentJob,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: `Worker process ${pid} is no longer running; the job ended without recording a result.`,
      completedAt,
      reaped: true
    };

    let latestTerminalJob = null;
    let latestActiveJob = null;
    let persistedReapJob = reapedJob;
    let reapLogFile = logFile;
    let persistedReap = false;
    try {
      withJobPersistenceLock(workspaceRoot, job.id, () => {
        let latestStoredJob = null;
        let latestStoredReadFailed = false;
        try {
          latestStoredJob = readStoredJob(workspaceRoot, job.id);
        } catch {
          latestStoredReadFailed = true;
        }

        const latestIndexedJob =
          listJobs(workspaceRoot).find((candidate) => candidate.id === job.id) ?? null;
        latestTerminalJob =
          [latestStoredJob, latestIndexedJob].find((candidate) => isTerminalJobStatus(candidate?.status)) ??
          null;
        if (latestTerminalJob) {
          return;
        }

        const latestActiveJobs = [latestStoredJob, latestIndexedJob].filter((candidate) =>
          isActiveJobStatus(candidate?.status)
        );
        const changedActiveJob = latestActiveJobs.find(
          (candidate) => !hasSameWorkerIdentity(candidate, probedWorker)
        );
        if (changedActiveJob) {
          latestActiveJob = {
            ...(latestIndexedJob ?? {}),
            ...(latestStoredJob ?? {}),
            ...changedActiveJob
          };
          return;
        }

        const activeJob = latestActiveJobs.length
          ? {
              ...(latestIndexedJob ?? {}),
              ...(latestStoredJob ?? {})
            }
          : currentJob;
        const activePid = activeJob.pid ?? pid;
        persistedReapJob = {
          ...activeJob,
          status: "failed",
          phase: "failed",
          pid: null,
          errorMessage: `Worker process ${activePid} is no longer running; the job ended without recording a result.`,
          completedAt: resolveReapCompletedAt(activeJob),
          reaped: true
        };
        reapLogFile = activeJob.logFile ?? null;

        if (!latestStoredReadFailed) {
          try {
            writeJobFile(workspaceRoot, job.id, persistedReapJob);
          } catch {
            // Status should still report the in-memory terminal record.
          }
        }

        try {
          upsertJob(workspaceRoot, persistedReapJob);
        } catch {
          // Status should still report the in-memory terminal record.
        }
        persistedReap = true;
      });
    } catch {
      // Status should still report the in-memory terminal record.
    }

    if (latestTerminalJob) {
      return latestTerminalJob;
    }

    if (latestActiveJob) {
      return latestActiveJob;
    }

    if (persistedReap) {
      try {
        if (reapLogFile && fs.existsSync(reapLogFile)) {
          appendLogLine(reapLogFile, `Job reaped: worker process ${pid} is gone; marking failed.`);
        }
      } catch {
        // A missing or unwritable log must not break status.
      }
    }

    return persistedReapJob;
  });
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  const selected = findJobReference(filtered, reference);
  if (selected) {
    return selected;
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

function findJobReference(jobs, reference) {
  if (!reference) {
    return jobs[0] ?? null;
  }

  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = jobs.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }
  return null;
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const allJobs = reapDeadJobs(workspaceRoot, sortJobsNewestFirst(listJobs(workspaceRoot)), options);
  const jobs = filterJobsForCurrentSession(allJobs, options);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = reapDeadJobs(workspaceRoot, sortJobsNewestFirst(listJobs(workspaceRoot)), options);
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const allJobs = reapDeadJobs(workspaceRoot, sortJobsNewestFirst(listJobs(workspaceRoot)));
  const jobs = reference ? allJobs : filterJobsForCurrentSession(allJobs);
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const listedJobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const jobs = reapDeadJobs(workspaceRoot, listedJobs, options);
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const listedActiveJobs = listedJobs.filter((job) => job.status === "queued" || job.status === "running");
    const requested = findJobReference(listedActiveJobs, reference);
    if (requested) {
      const selected = activeJobs.find((job) => job.id === requested.id);
      if (selected) {
        return { workspaceRoot, job: selected };
      }

      const reaped = jobs.find((job) => job.id === requested.id);
      if (reaped?.status === "failed" && reaped.reaped === true) {
        return { workspaceRoot, job: reaped, outcome: "reaped" };
      }
    }

    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
