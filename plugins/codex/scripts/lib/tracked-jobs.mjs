import fs from "node:fs";
import process from "node:process";

import { getProcessStartTime } from "./process.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  withJobPersistenceLock,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    withJobPersistenceLock(workspaceRoot, jobId, () => {
      if (isPersistenceBlocked(workspaceRoot, jobId)) {
        return;
      }
      upsertJob(workspaceRoot, patch);

      const jobFile = resolveJobFile(workspaceRoot, jobId);
      if (!fs.existsSync(jobFile)) {
        return;
      }

      const storedJob = readJobFile(jobFile);
      if (isTerminalJobStatus(storedJob.status) || isPersistenceBlocked(workspaceRoot, jobId)) {
        return;
      }
      writeJobFile(workspaceRoot, jobId, {
        ...storedJob,
        ...patch
      });
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function readIndexedJobOrNull(workspaceRoot, jobId) {
  return listJobs(workspaceRoot).find((job) => job.id === jobId) ?? null;
}

function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

function hasTerminalJobRecord(workspaceRoot, jobId) {
  const storedJob = readStoredJobOrNull(workspaceRoot, jobId);
  if (isTerminalJobStatus(storedJob?.status)) {
    return true;
  }
  return isTerminalJobStatus(readIndexedJobOrNull(workspaceRoot, jobId)?.status);
}

function isPersistenceBlocked(workspaceRoot, jobId) {
  return hasTerminalJobRecord(workspaceRoot, jobId);
}

export async function runTrackedJob(job, runner, options = {}) {
  const getProcessStartTimeImpl = options.getProcessStartTime ?? getProcessStartTime;
  let pidStartTime = null;
  try {
    pidStartTime = getProcessStartTimeImpl(process.pid);
  } catch {
    // A missing process probe must not prevent the worker from starting.
  }

  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    pidStartTime,
    logFile: options.logFile ?? job.logFile ?? null
  };
  const runningPersisted = withJobPersistenceLock(job.workspaceRoot, job.id, () => {
    if (job.status && isPersistenceBlocked(job.workspaceRoot, job.id)) {
      return false;
    }
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, runningRecord);
    return true;
  });
  if (!runningPersisted) {
    return null;
  }

  let handlingSignal = false;
  const signalHandlers = new Map();
  const handleSignal = (signal) => {
    const handler = signalHandlers.get(signal);
    if (handlingSignal) {
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
      return;
    }
    handlingSignal = true;

    try {
      let existing = runningRecord;
      withJobPersistenceLock(job.workspaceRoot, job.id, () => {
        existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
        if (existing.status !== "running" || isPersistenceBlocked(job.workspaceRoot, job.id)) {
          return;
        }
        const completedAt = nowIso();
        const errorMessage = `Job terminated by signal ${signal}.`;
        writeJobFile(job.workspaceRoot, job.id, {
          ...existing,
          status: "failed",
          phase: "failed",
          pid: null,
          completedAt,
          errorMessage
        });
        upsertJob(job.workspaceRoot, {
          id: job.id,
          status: "failed",
          phase: "failed",
          pid: null,
          completedAt,
          errorMessage
        });
      });
      appendLogLine(
        options.logFile ?? job.logFile ?? existing.logFile ?? null,
        `Job terminated by signal ${signal}.`
      );
    } finally {
      process.removeListener(signal, handler);
      // runTrackedJob owns the process's sole listener for this signal; after removal,
      // re-sending it restores Node's default termination behavior.
      process.kill(process.pid, signal);
    }
  };
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const handler = () => handleSignal(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    if (isPersistenceBlocked(job.workspaceRoot, job.id)) {
      return execution;
    }
    options.beforeTerminalPersistence?.();
    const completionPersisted = withJobPersistenceLock(job.workspaceRoot, job.id, () => {
      if (isPersistenceBlocked(job.workspaceRoot, job.id)) {
        return false;
      }
      writeJobFile(job.workspaceRoot, job.id, {
        ...runningRecord,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        pid: null,
        phase: completionStatus === "completed" ? "done" : "failed",
        completedAt,
        result: execution.payload,
        rendered: execution.rendered
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase: completionStatus === "completed" ? "done" : "failed",
        pid: null,
        completedAt
      });
      return true;
    });
    if (completionPersisted) {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    }
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    withJobPersistenceLock(job.workspaceRoot, job.id, () => {
      if (isPersistenceBlocked(job.workspaceRoot, job.id)) {
        return;
      }
      const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
      writeJobFile(job.workspaceRoot, job.id, {
        ...existing,
        status: "failed",
        phase: "failed",
        errorMessage,
        pid: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage,
        completedAt
      });
    });
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
}
