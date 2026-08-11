/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").RunAppServerTurnOptions} RunAppServerTurnOptions
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   activityTimer: ReturnType<typeof setTimeout> | null,
 *   lastActivityAt: number | null,
 *   activityCount: number,
 *   itemActivityCount: number,
 *   stallCleanup: Promise<void> | null,
 *   stalled: boolean,
 *   activeTools: Map<string, { threadId: string | null, itemId: string | null, toolClass: string, label: string, inactivityTimeoutMs: number, deadlineTimer: ReturnType<typeof setTimeout> | null, armedAt: number | null }>,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { CAPACITY, STALLED, classifyFailureMessage } from "./failure-class.mjs";
import { resolveWorktreeWritableRoots } from "./git.mjs";
import { binaryAvailable } from "./process.mjs";
import { getConfig } from "./state.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TURN_STALL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TOOL_STALL_TIMEOUT_MS = 90 * 1000;
const DEFAULT_MCP_TOOL_STALL_TIMEOUT_MS = 180 * 1000;
const DEFAULT_TOOL_MAX_INFLIGHT_MS = 5 * 60 * 1000;
// Quick tools should answer fast and/or stream; a silent one past the tool budget is wedged,
// and even a chatty one past the max-in-flight cap is looping. Long tools (shell commands,
// subagent collaborations) can legitimately run long and silent, so they use the turn backstop
// for inactivity and get no wall-clock cap.
const QUICK_TOOL_TYPES = new Set(["mcpToolCall", "webSearch", "customToolCall", "dynamicToolCall"]);
const LONG_TOOL_TYPES = new Set(["commandExecution", "collabAgentToolCall"]);
const TURN_INTERRUPT_TIMEOUT_MS = 5000;
const INTERRUPT_TIMEOUT_MS = 10_000;
const INTERRUPT_CLEANUP_TIMEOUT_MS = 1_000;

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  const params = {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
  const config = { ...(options.config ?? {}) };
  for (const name of resolveDisabledMcpServers()) {
    config[`mcp_servers.${name}.enabled`] = false;
  }
  if (options.writableRoots?.length > 0) {
    config["sandbox_workspace_write.writable_roots"] = options.writableRoots;
  }
  if (Object.keys(config).length > 0) {
    params.config = config;
  }
  return params;
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  const params = {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
  const config = { ...(options.config ?? {}) };
  for (const name of resolveDisabledMcpServers()) {
    config[`mcp_servers.${name}.enabled`] = false;
  }
  if (options.writableRoots?.length > 0) {
    config["sandbox_workspace_write.writable_roots"] = options.writableRoots;
  }
  if (Object.keys(config).length > 0) {
    params.config = config;
  }
  return params;
}

function buildTurnSandboxPolicy(sandbox, writableRoots, resolvedSandbox) {
  if (sandbox === "workspace-write") {
    const base = resolvedSandbox?.type === "workspaceWrite" ? resolvedSandbox : null;
    const roots = new Set([...(base?.writableRoots ?? []), ...(writableRoots ?? [])]);
    return {
      type: "workspaceWrite",
      writableRoots: [...roots],
      networkAccess: base?.networkAccess ?? false,
      excludeTmpdirEnvVar: base?.excludeTmpdirEnvVar ?? false,
      excludeSlashTmp: base?.excludeSlashTmp ?? false
    };
  }
  if (sandbox === "read-only") {
    const base = resolvedSandbox?.type === "readOnly" ? resolvedSandbox : null;
    return {
      type: "readOnly",
      networkAccess: base?.networkAccess ?? false
    };
  }
  if (sandbox === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  return null;
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function resolveStallTimeoutMs(options = {}) {
  if (options.stallTimeoutMs !== undefined) {
    return Number(options.stallTimeoutMs);
  }
  const envValue = Number(process.env.CODEX_TURN_STALL_TIMEOUT_MS);
  if (Number.isFinite(envValue) && envValue >= 0) {
    return envValue;
  }
  return DEFAULT_TURN_STALL_TIMEOUT_MS;
}

function resolveToolStallTimeoutMs(options = {}) {
  if (options.toolStallTimeoutMs !== undefined) {
    return Number(options.toolStallTimeoutMs);
  }
  const envValue = Number(process.env.CODEX_TOOL_STALL_TIMEOUT_MS);
  if (Number.isFinite(envValue) && envValue >= 0) {
    return envValue;
  }
  return DEFAULT_TOOL_STALL_TIMEOUT_MS;
}

function resolveMcpToolStallTimeoutMs(options = {}) {
  if (options.mcpToolStallTimeoutMs !== undefined) {
    return Number(options.mcpToolStallTimeoutMs);
  }
  const envValue = Number(process.env.CODEX_MCP_TOOL_STALL_TIMEOUT_MS);
  if (Number.isFinite(envValue) && envValue >= 0) {
    return envValue;
  }
  return DEFAULT_MCP_TOOL_STALL_TIMEOUT_MS;
}

function resolveToolMaxInFlightMs(options = {}) {
  if (options.toolMaxInFlightMs !== undefined) {
    return Number(options.toolMaxInFlightMs);
  }
  const envValue = Number(process.env.CODEX_TOOL_MAX_INFLIGHT_MS);
  if (Number.isFinite(envValue) && envValue >= 0) {
    return envValue;
  }
  return DEFAULT_TOOL_MAX_INFLIGHT_MS;
}

function resolveDisabledMcpServers() {
  const seen = new Set();
  const disabled = [];
  for (const entry of (process.env.CODEX_DISABLED_MCP_SERVERS ?? "").split(",")) {
    const name = entry.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    // Only a bare TOML key can be spliced into a dotted config path. Quoting the name instead
    // makes Codex read the segment as a new server table with no transport, which fails
    // thread/start for the whole run rather than just leaving that server enabled.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      process.stderr.write(`Skipping disabled MCP server "${name}": not a bare TOML key.\n`);
      continue;
    }
    disabled.push(name);
  }
  return disabled;
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function turnProducedNothing(turnState) {
  return (
    turnState.itemActivityCount === 0 &&
    turnState.messages.length === 0 &&
    turnState.fileChanges.length === 0 &&
    turnState.commandExecutions.length === 0 &&
    !turnState.lastAgentMessage
  );
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    activityTimer: null,
    lastActivityAt: null,
    activityCount: 0,
    itemActivityCount: 0,
    stallCleanup: null,
    stalled: false,
    activeTools: new Map(),
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function clearActivityTimer(state) {
  if (state.activityTimer) {
    clearTimeout(state.activityTimer);
    state.activityTimer = null;
  }
}

// Active tools are keyed by thread + item so overlapping main/subagent tool calls each keep their
// own class, label, and wall-clock deadline instead of sharing one global slot.
function activeToolKey(threadId, itemId) {
  return `${threadId ?? "root"}:${itemId ?? "?"}`;
}

function maxActiveQuickToolStallTimeout(state) {
  let maxTimeoutMs = null;
  for (const tool of state.activeTools.values()) {
    if (tool.toolClass === "quick") {
      maxTimeoutMs = maxTimeoutMs === null ? tool.inactivityTimeoutMs : Math.max(maxTimeoutMs, tool.inactivityTimeoutMs);
    }
  }
  return maxTimeoutMs;
}

function activeToolLabels(state) {
  const labels = [];
  for (const tool of state.activeTools.values()) {
    if (tool.label) {
      labels.push(tool.label);
    }
  }
  return labels;
}

// Wall-clock cap for a single in-flight quick tool. Armed once when the tool starts and NOT rearmed
// by activity, so a tool that stays alive by streaming forever still gets cut off. Long tools get no
// cap.
function trackToolStart(state, client, threadId, item, label, maxInFlightMs, inactivityTimeoutMs) {
  const cls = toolClass(item);
  if (!cls) {
    return;
  }
  const key = activeToolKey(threadId, item?.id);
  removeActiveTool(state, key);
  const entry = {
    threadId: threadId ?? null,
    itemId: item?.id ?? null,
    toolClass: cls,
    label,
    inactivityTimeoutMs,
    deadlineTimer: null,
    armedAt: null
  };
  state.activeTools.set(key, entry);
  if (cls === "quick" && !state.completed && maxInFlightMs > 0 && Number.isFinite(maxInFlightMs)) {
    entry.armedAt = Date.now();
    entry.deadlineTimer = setTimeout(() => {
      entry.deadlineTimer = null;
      state.stallCleanup = handleStall(state, client, maxInFlightMs, "tool-max", entry.label, entry.armedAt);
    }, maxInFlightMs);
    entry.deadlineTimer.unref?.();
  }
}

function removeActiveTool(state, key) {
  const entry = state.activeTools.get(key);
  if (!entry) {
    return;
  }
  if (entry.deadlineTimer) {
    clearTimeout(entry.deadlineTimer);
    entry.deadlineTimer = null;
  }
  state.activeTools.delete(key);
}

function clearActiveTools(state) {
  for (const entry of state.activeTools.values()) {
    if (entry.deadlineTimer) {
      clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = null;
    }
  }
  state.activeTools.clear();
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  clearActivityTimer(state);
  clearActiveTools(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0 || state.activeTools.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0 || state.activeTools.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function toolClass(item) {
  if (QUICK_TOOL_TYPES.has(item?.type)) {
    return "quick";
  }
  if (LONG_TOOL_TYPES.has(item?.type)) {
    return "long";
  }
  return null;
}

function isActiveToolItem(item) {
  return toolClass(item) !== null;
}

function isFailedItemStatus(status) {
  return ["failed", "declined", "error", "errored", "cancelled", "canceled"].includes(String(status ?? "").toLowerCase());
}

function extractErrorMessage(value) {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  for (const key of ["message", "detail", "errorMessage", "failureMessage", "stderr", "output", "aggregatedOutput"]) {
    const message = extractErrorMessage(value[key]);
    if (message) {
      return message;
    }
  }
  return null;
}

function labelForToolItem(item) {
  if (item.type === "mcpToolCall") {
    return [item.server, item.tool].filter(Boolean).join("/") || "MCP tool";
  }
  if (item.type === "commandExecution") {
    return item.command ? `command ${shorten(item.command, 96)}` : "command";
  }
  if (item.type === "customToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
    return item.tool ?? "tool";
  }
  if (item.type === "webSearch") {
    return item.query ? `web search ${shorten(item.query, 96)}` : "web search";
  }
  return "tool";
}

function errorForFailedToolItem(item) {
  if (!isActiveToolItem(item) || !isFailedItemStatus(item.status)) {
    return null;
  }
  const detail =
    extractErrorMessage(item.error) ??
    extractErrorMessage(item.failure) ??
    extractErrorMessage(item.result) ??
    extractErrorMessage(item);
  return {
    message: detail ?? `${labelForToolItem(item)} ${item.status}.`
  };
}

async function interruptTurnWithTimeout(client, threadId, turnId) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, TURN_INTERRUPT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([client.request("turn/interrupt", { threadId, turnId }), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function formatStallDuration(ms) {
  if (!Number.isFinite(ms)) {
    return null;
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  return `${Math.round(ms / 1000)}s`;
}

// Timings below are deliberately wall-clock (`Date.now`), not monotonic. `setTimeout` runs on loop
// time, which stops while the machine sleeps, so a monotonic measurement would always agree with the
// budget and hide the very overshoot this reports. The gap between the two clocks is the diagnostic:
// wall-clock elapsed far above the budget means the timer lost time it could not observe.
async function handleStall(state, client, stallTimeoutMs, stallMode, itemLabel = null, armedAt = null) {
  if (state.completed) {
    return;
  }

  state.stalled = true;
  const now = Date.now();
  const budgetSeconds = Math.round(stallTimeoutMs / 1000);
  const measuredMs =
    stallMode === "tool-max"
      ? Number.isFinite(armedAt)
        ? now - armedAt
        : null
      : Number.isFinite(state.lastActivityAt)
        ? now - state.lastActivityAt
        : null;
  const lateMs = Number.isFinite(armedAt) && Number.isFinite(stallTimeoutMs)
    ? now - (armedAt + stallTimeoutMs)
    : null;
  const labels = itemLabel ? [itemLabel] : activeToolLabels(state);
  const itemDetail = labels.length ? ` while "${labels.join(", ")}" was in flight` : "";
  const modeDetail = stallMode === "tool" ? "tool-in-flight" : stallMode === "tool-max" ? "tool-max-duration" : "idle";
  const reason =
    stallMode === "tool-max"
      ? `in flight for ${budgetSeconds}s without completing (exceeded max tool duration)`
      : `no activity for ${budgetSeconds}s`;
  const detailParts = [];
  const budget = formatStallDuration(stallTimeoutMs);
  if (budget) {
    detailParts.push(`budget ${budget}`);
  }
  if (Number.isFinite(measuredMs)) {
    if (stallMode === "tool-max") {
      detailParts.push(`measured ${formatStallDuration(measuredMs)} since the tool deadline was armed`);
    } else {
      let activityDetail = `measured ${formatStallDuration(measuredMs)} since the last of ${state.activityCount} activity events`;
      if (Number.isFinite(state.lastActivityAt)) {
        activityDetail += ` at ${new Date(state.lastActivityAt).toISOString()}`;
      }
      detailParts.push(activityDetail);
    }
  }
  if (stallMode === "tool-max") {
    detailParts.push(`${state.activityCount} activity events`);
    if (Number.isFinite(state.lastActivityAt)) {
      detailParts.push(`last activity at ${new Date(state.lastActivityAt).toISOString()}`);
    }
  }
  if (Number.isFinite(lateMs) && lateMs > 1000) {
    detailParts.push(`timer fired ${formatStallDuration(lateMs)} late`);
  }
  const detail = detailParts.length ? ` [${detailParts.join("; ")}]` : "";
  const message = `Codex turn stalled (${modeDetail}): ${reason}${itemDetail}${detail}. Interrupting and aborting the turn.`;
  state.error ??= { message };
  emitLogEvent(state.onProgress, {
    message,
    stderrMessage: message,
    phase: "failed",
    logTitle: "Codex turn stalled",
    logBody: message
  });
  completeTurn(state, { id: state.turnId ?? "stalled-turn", status: "stalled" });

  try {
    if (state.threadId && state.turnId) {
      await interruptTurnWithTimeout(client, state.threadId, state.turnId);
    }
  } catch {
    // Interrupt is advisory; local completion above is what unblocks the caller.
  }
}

function bumpActivity(state, client, stallTimeouts) {
  if (state.completed) {
    return;
  }

  state.lastActivityAt = Date.now();
  state.activityCount += 1;

  // A single global inactivity timer covers the whole turn. The most patient quick tool in flight
  // controls the silence window because the watchdog measures whether anything at all is happening
  // on the turn. The turn backstop remains the outer bound; long tools use it directly.
  // A zero or non-finite turn budget means the backstop is switched off, so there is no outer bound
  // to clamp against and the tool budget stands on its own.
  const quickToolTimeoutMs = maxActiveQuickToolStallTimeout(state);
  const turnBackstopMs = stallTimeouts.turn;
  const clampsToBackstop = Number.isFinite(turnBackstopMs) && turnBackstopMs > 0;
  const stallMode = quickToolTimeoutMs === null ? "idle" : "tool";
  const stallTimeoutMs =
    stallMode === "tool"
      ? clampsToBackstop
        ? Math.min(quickToolTimeoutMs, turnBackstopMs)
        : quickToolTimeoutMs
      : turnBackstopMs;

  clearActivityTimer(state);
  if (stallTimeoutMs > 0 && Number.isFinite(stallTimeoutMs)) {
    const armedAt = Date.now();
    state.activityTimer = setTimeout(() => {
      clearActivityTimer(state);
      state.stallCleanup = handleStall(state, client, stallTimeoutMs, stallMode, null, armedAt);
    }, stallTimeoutMs);
    state.activityTimer.unref?.();
  }
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  state.itemActivityCount += 1;

  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message, watchdog = null) {
  // Turn already finalized (normal, inferred, or stalled) -- don't mutate the settled result.
  if (state.completed) {
    return;
  }

  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        if (isActiveToolItem(message.params.item)) {
          watchdog?.toolStarted(message.params.threadId ?? null, message.params.item, update?.message ?? "active tool");
        }
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        if (isActiveToolItem(message.params.item)) {
          state.error ??= errorForFailedToolItem(message.params.item);
          watchdog?.toolEnded(message.params.threadId ?? null, message.params.item?.id);
          scheduleInferredCompletion(state);
        }
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      // A top-level error carries no item id, so it can't be pinned to a specific tool. Only clear
      // the in-flight marker when exactly one tool is active (the error must be about that one).
      // With overlapping tools we can't attribute it, so leave them for their own watchdogs rather
      // than dropping an unrelated tool's deadline or letting inference finish over a live tool.
      if (state.activeTools.size === 1) {
        watchdog?.clearActiveTools();
      }
      state.error ??= message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      scheduleInferredCompletion(state);
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;
  const stallTimeouts = {
    turn: resolveStallTimeoutMs(options),
    tool: resolveToolStallTimeoutMs(options),
    mcpTool: resolveMcpToolStallTimeoutMs(options),
    toolMaxInFlight: resolveToolMaxInFlightMs(options)
  };
  const rearmActivity = () => bumpActivity(state, client, stallTimeouts);
  const watchdog = {
    rearm: rearmActivity,
    toolStarted: (toolThreadId, item, label) => {
      trackToolStart(
        state,
        client,
        toolThreadId,
        item,
        label,
        stallTimeouts.toolMaxInFlight,
        item.type === "mcpToolCall" ? stallTimeouts.mcpTool : stallTimeouts.tool
      );
      rearmActivity();
    },
    toolEnded: (toolThreadId, itemId) => {
      removeActiveTool(state, activeToolKey(toolThreadId, itemId));
      rearmActivity();
    },
    clearActiveTools: () => {
      clearActiveTools(state);
      rearmActivity();
    }
  };

  client.setNotificationHandler((message) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      bumpActivity(state, client, stallTimeouts);
      applyTurnNotification(state, message, watchdog);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }

    bumpActivity(state, client, stallTimeouts);
    applyTurnNotification(state, message, watchdog);
  });

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
      bumpActivity(state, client, stallTimeouts);
    }
    for (const message of state.bufferedNotifications) {
      if (message.method === "thread/started" || message.method === "thread/name/updated") {
        bumpActivity(state, client, stallTimeouts);
        applyTurnNotification(state, message, watchdog);
      } else if (belongsToTurn(state, message)) {
        bumpActivity(state, client, stallTimeouts);
        applyTurnNotification(state, message, watchdog);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    const result = await state.completion;
    if (state.stallCleanup) {
      await state.stallCleanup.catch(() => {});
    }
    return result;
  } finally {
    clearCompletionTimer(state);
    clearActivityTimer(state);
    clearActiveTools(state);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function classifyTurnFailure(turnState, status) {
  if (status === 0) {
    return { failureClass: null, retryable: false, retryAfterMs: null };
  }
  // A watchdog abort is a fact about the turn, not a string in the error, so it is read from the
  // turn state rather than matched out of the message.
  const failure = turnState.stalled === true
    ? { failureClass: STALLED, retryable: true, retryAfterMs: null }
    : classifyFailureMessage(extractErrorMessage(turnState.error));
  // Repeating is only safe when the turn left nothing behind, and pacing is guidance for a retry
  // that is actually on offer.
  const retryable = failure.retryable && turnProducedNothing(turnState);
  return {
    failureClass: failure.failureClass,
    retryable,
    retryAfterMs: retryable ? failure.retryAfterMs : null
  };
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  const deadline = Date.now() + INTERRUPT_TIMEOUT_MS;
  const remaining = () => Math.max(0, deadline - Date.now());
  let client = null;
  try {
    const connectTimeoutMs = remaining();
    if (connectTimeoutMs === 0) {
      throw new Error(`codex app-server initialize timed out after ${INTERRUPT_TIMEOUT_MS}ms.`);
    }
    client = await CodexAppServerClient.connect(cwd, {
      reuseExistingBroker: true,
      timeoutMs: connectTimeoutMs
    });

    const requestTimeoutMs = remaining();
    if (requestTimeoutMs === 0) {
      throw new Error(`codex app-server turn/interrupt timed out after ${INTERRUPT_TIMEOUT_MS}ms.`);
    }
    await client.request(
      "turn/interrupt",
      { threadId, turnId },
      { timeoutMs: requestTimeoutMs }
    );
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (client) {
      // Cleanup gets a short bounded budget so healthy connections can close without
      // stacking another full operation budget.
      await client.close({ timeoutMs: INTERRUPT_CLEANUP_TIMEOUT_MS }).catch(() => {});
    }
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const delivery = options.delivery ?? "inline";
    const captureModelReview = async (model) => {
      emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
      const thread = await startThread(client, cwd, {
        model,
        sandbox: "read-only",
        ephemeral: true,
        threadName: options.threadName
      });
      const sourceThreadId = thread.thread.id;
      emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
        threadId: sourceThreadId
      });

      const turnState = await captureTurn(
        client,
        sourceThreadId,
        () =>
          client.request("review/start", {
            threadId: sourceThreadId,
            delivery,
            target: options.target
          }),
        {
          onProgress: options.onProgress,
          onResponse(response, state) {
            if (response.reviewThreadId) {
              state.threadIds.add(response.reviewThreadId);
              if (delivery === "detached") {
                state.threadId = response.reviewThreadId;
              }
            }
          }
        }
      );
      return {
        resolvedModel: thread.model ?? model ?? null,
        sourceThreadId,
        turnState
      };
    };

    let reviewAttempt = await captureModelReview(options.model ?? null);
    const failedModel = reviewAttempt.resolvedModel;
    const initialStatus = buildResultStatus(reviewAttempt.turnState);
    const initialFailure = classifyTurnFailure(reviewAttempt.turnState, initialStatus);
    let modelFallback = null;

    if (
      initialStatus !== 0 &&
      initialFailure.failureClass === CAPACITY &&
      turnProducedNothing(reviewAttempt.turnState)
    ) {
      const fallbackModel = await resolveFallbackModel(client, {
        failedModel,
        workspaceRoot: cwd,
        env: process.env
      });
      if (fallbackModel && fallbackModel !== failedModel) {
        emitProgress(
          options.onProgress,
          `Model ${failedModel} is at capacity; retrying on ${fallbackModel}.`,
          "starting"
        );
        reviewAttempt = await captureModelReview(fallbackModel);
        modelFallback = { from: failedModel, to: fallbackModel, reason: "capacity" };
      }
    }

    const { sourceThreadId, turnState } = reviewAttempt;
    const status = buildResultStatus(turnState);
    const failure = classifyTurnFailure(turnState, status);

    return {
      status,
      failureClass: failure.failureClass,
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
      modelFallback,
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

// `stopWhen` lets a caller that is hunting one entry stop as soon as it appears
// instead of paying for the remaining pages.
async function listAdvertisedModels(client, stopWhen = null) {
  try {
    const modelListDeadline = Date.now() + 3000;
    const seenCursors = new Set();
    const advertisedModels = [];
    let cursor = null;
    // Bound pages and total time so a malformed server cannot delay the turn indefinitely.
    for (let page = 0; page < 10 && Date.now() < modelListDeadline; page += 1) {
      const params = { includeHidden: true };
      if (cursor !== null) {
        params.cursor = cursor;
      }
      const remainingMs = modelListDeadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      const modelListResponse = await client.request(
        "model/list",
        params,
        { timeoutMs: Math.min(3000, remainingMs) }
      );
      const models = modelListResponse?.data;
      const nextCursor = modelListResponse?.nextCursor;
      if (!Array.isArray(models) || (nextCursor !== null && typeof nextCursor !== "string")) {
        throw new Error("Unexpected model/list response.");
      }
      advertisedModels.push(...models);
      if (stopWhen?.(advertisedModels) || nextCursor === null || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return advertisedModels;
  } catch {
    // This lookup is advisory; fail open so model discovery cannot make a working run fail.
    return [];
  }
}

function advertisedModelName(entry) {
  for (const value of [entry?.model, entry?.id]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export async function resolveFallbackModel(client, { failedModel, workspaceRoot, env = process.env }) {
  const envModel = typeof env?.CODEX_COMPANION_FALLBACK_MODEL === "string"
    ? env.CODEX_COMPANION_FALLBACK_MODEL.trim()
    : "";
  if (envModel.toLowerCase() === "none") {
    return null;
  }
  if (envModel) {
    return envModel;
  }

  const configuredModel = getConfig(workspaceRoot).fallbackModel;
  if (typeof configuredModel === "string" && configuredModel.trim()) {
    return configuredModel.trim();
  }

  const models = await listAdvertisedModels(client);
  const eligibleModels = models.filter((entry) => !entry?.hidden && advertisedModelName(entry) !== failedModel);
  const fallbackEntry = eligibleModels.find((entry) => entry?.isDefault === true) ?? eligibleModels[0];
  return advertisedModelName(fallbackEntry);
}

/** @param {RunAppServerTurnOptions} [options] */
export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    let threadId;
    let resolvedModel = null;
    let resolvedSandbox = null;
    const writableRoots = options.sandbox === "workspace-write" ? resolveWorktreeWritableRoots(cwd) : undefined;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false,
        writableRoots
      });
      threadId = response.thread.id;
      resolvedModel = response.model ?? null;
      resolvedSandbox = response.sandbox ?? null;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null,
        writableRoots
      });
      threadId = response.thread.id;
      resolvedModel = response.model ?? null;
      resolvedSandbox = response.sandbox ?? null;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    let effortWarning = null;
    // model/list is a conservative advertisement, so an omitted effort is a warning rather than a rejection.
    if (typeof options.effort === "string" && options.effortOverride !== false) {
      const matchesResolvedModel = (entry) => entry?.model === resolvedModel || entry?.id === resolvedModel;
      const models = typeof resolvedModel === "string"
        ? await listAdvertisedModels(client, (entries) => entries.some(matchesResolvedModel))
        : await listAdvertisedModels(client);
      const modelEntry = typeof resolvedModel === "string" ? models.find(matchesResolvedModel) : null;
      const advertisedEfforts = modelEntry?.supportedReasoningEfforts;
      if (
        modelEntry &&
        Array.isArray(advertisedEfforts) &&
        advertisedEfforts.every((entry) => typeof entry?.reasoningEffort === "string") &&
        !advertisedEfforts.some((entry) => entry.reasoningEffort === options.effort)
      ) {
        const advertised = advertisedEfforts.map((entry) => entry.reasoningEffort).join(", ");
        effortWarning = `${resolvedModel} does not advertise reasoning effort "${options.effort}" (advertised: ${advertised}). Codex may ignore or reject it; the effort actually used is not reported by the protocol.`;
        emitProgress(options.onProgress, effortWarning);
      }
    }

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const sandboxPolicy = buildTurnSandboxPolicy(options.sandbox, writableRoots, resolvedSandbox);
    const captureModelTurn = (model) =>
      captureTurn(
        client,
        threadId,
        () => client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null,
          sandboxPolicy
        }),
        { onProgress: options.onProgress }
      );

    const failedModel = resolvedModel ?? options.model ?? null;
    let turnState = await captureModelTurn(options.model ?? null);
    const initialStatus = buildResultStatus(turnState);
    const initialFailure = classifyTurnFailure(turnState, initialStatus);
    let modelFallback = null;

    if (initialStatus !== 0 && initialFailure.failureClass === CAPACITY && turnProducedNothing(turnState)) {
      const fallbackModel = await resolveFallbackModel(client, {
        failedModel,
        workspaceRoot: cwd,
        env: process.env
      });
      if (fallbackModel && fallbackModel !== failedModel) {
        emitProgress(
          options.onProgress,
          `Model ${failedModel} is at capacity; retrying on ${fallbackModel}.`,
          "starting"
        );
        turnState = await captureModelTurn(fallbackModel);
        modelFallback = { from: failedModel, to: fallbackModel, reason: "capacity" };
      }
    }

    const status = buildResultStatus(turnState);
    const failure = classifyTurnFailure(turnState, status);

    return {
      status,
      failureClass: failure.failureClass,
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
      modelFallback,
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      effortWarning,
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  });
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
