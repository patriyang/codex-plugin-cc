import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, spawnDeadPid, trackedTempDirs, writeExecutable } from "./helpers.mjs";
import {
  ensureBrokerSession,
  loadBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession,
  waitForBrokerEndpoint
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { resolveFallbackModel, runAppServerTurn } from "../plugins/codex/scripts/lib/codex.mjs";
import { classifyFailureMessage } from "../plugins/codex/scripts/lib/failure-class.mjs";
import { getProcessStartTime } from "../plugins/codex/scripts/lib/process.mjs";
import { splitRawArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import {
  resolveClaudeSessionPath,
  TRANSCRIPT_PATH_ENV
} from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";
import {
  ensureStateDir,
  getConfig,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitForProcessExit(pid) {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
}

async function startTestBroker(t, onRequest, { allowHalfOpen = false } = {}) {
  const socketPath = path.join(makeTempDir(), "app-server.sock");
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen }, (socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) {
          onRequest(socket, JSON.parse(line));
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });

  return `unix:${socketPath}`;
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Child process did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

after(async () => {
  for (const dir of trackedTempDirs()) {
    let session = null;
    try {
      session = loadBrokerSession(dir);
    } catch {
      session = null;
    }
    if (!session || (!session.endpoint && !session.pid)) {
      continue;
    }
    // Ask the broker to shut down gracefully first so it closes its own `codex app-server` child;
    // a SIGKILL would orphan that child and re-leak the app-server half.
    if (session.endpoint) {
      await sendBrokerShutdown(session.endpoint).catch(() => {});
    }
    // Only SIGTERM the recorded PID if the broker is still reachable on its (unique) endpoint —
    // proof it's genuinely our live broker. A stale broker.json can hold an already-exited broker's
    // PID that the OS may have recycled, so never kill a recorded PID blindly.
    const stillReachable = session.endpoint
      ? await waitForBrokerEndpoint(session.endpoint, 100).catch(() => false)
      : false;
    teardownBrokerSession({
      endpoint: session.endpoint ?? null,
      pidFile: session.pidFile ?? null,
      logFile: session.logFile ?? null,
      sessionDir: session.sessionDir ?? null,
      pid: stillReachable ? session.pid ?? null : null,
      // Backstop if the graceful shutdown didn't land. SIGTERM (not SIGKILL) lets the broker's
      // signal handler close the app-server child. Guarded on reachability above.
      killProcess: stillReachable
        ? (pid) => {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              // already gone
            }
          }
        : null
    });
  }
});

test("app-server request times out when the peer never replies", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "request-never-replies");
  const client = await CodexAppServerClient.connect(workspace, {
    disableBroker: true,
    env: buildEnv(binDir)
  });
  t.after(() => client.close());

  await assert.rejects(
    client.request("thread/list", {}, { timeoutMs: 25 }),
    /codex app-server thread\/list timed out after 25ms\./
  );
});

test("app-server request resolves when the peer replies before the timeout", async (t) => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  const client = await CodexAppServerClient.connect(workspace, {
    disableBroker: true,
    env: buildEnv(binDir)
  });
  t.after(() => client.close());

  const result = await client.request("thread/list", {}, { timeoutMs: 1000 });

  assert.deepEqual(result, { data: [], nextCursor: null });
});

test("app-server connect timeout destroys a client whose initialize never replies", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "initialize-never-replies");

  await assert.rejects(
    CodexAppServerClient.connect(workspace, {
      disableBroker: true,
      env: buildEnv(binDir),
      timeoutMs: 2000
    }),
    /codex app-server initialize timed out after 2000ms\./
  );

  const fakeState = await waitFor(() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
      return Number.isFinite(parsed.appServerPid) ? parsed : null;
    } catch {
      return null;
    }
  });
  await waitForProcessExit(fakeState.appServerPid);
});

test("app-server close timeout destroys a client whose transport does not close", async () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "close-stalls");
  const client = await CodexAppServerClient.connect(workspace, {
    disableBroker: true,
    env: buildEnv(binDir)
  });
  const childPid = client.proc.pid;

  const startedAt = Date.now();
  await client.close({ timeoutMs: 25 });

  assert.ok(Date.now() - startedAt < 250);
  await waitForProcessExit(childPid);
});

test("app-server connect destroys broker transport when initialize rejects", async (t) => {
  const workspace = makeTempDir();
  let connectionClosed = false;
  const endpoint = await startTestBroker(t, (socket, message) => {
    if (message.method === "initialize") {
      socket.once("close", () => {
        connectionClosed = true;
      });
      socket.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32000, message: "initialize rejected" }
      })}\n`);
    }
  });

  await assert.rejects(
    CodexAppServerClient.connect(workspace, { brokerEndpoint: endpoint }),
    /initialize rejected/
  );
  await waitFor(() => connectionClosed);
  assert.equal(connectionClosed, true);
});

test("an unrecognized flag fails loudly instead of leaking into a prompt or being silently ignored", () => {
  const binDir = makeTempDir();

  const result = run("node", [SCRIPT, "status", "--bogus"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option: --bogus/);
});

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.codex.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup configures, reports, and clears the fallback model", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const configured = run("node", [SCRIPT, "setup", "--fallback-model", " configured-backup ", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(configured.status, 0, configured.stderr);
  const configuredPayload = JSON.parse(configured.stdout);
  assert.equal(configuredPayload.fallbackModel, "configured-backup");
  assert.match(configuredPayload.actionsTaken.join("\n"), /Configured fallback model configured-backup/);
  assert.equal(getConfig(repo).fallbackModel, "configured-backup");

  const blank = run("node", [SCRIPT, "setup", "--fallback-model", "   ", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.notEqual(blank.status, 0);
  assert.match(blank.stderr, /--fallback-model requires a non-empty model name/);
  assert.equal(getConfig(repo).fallbackModel, "configured-backup");

  const conflicting = run(
    "node",
    [SCRIPT, "setup", "--fallback-model", "another-backup", "--clear-fallback-model", "--json"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /Choose either --fallback-model or --clear-fallback-model/);

  const cleared = run("node", [SCRIPT, "setup", "--clear-fallback-model", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(cleared.status, 0, cleared.stderr);
  const clearedPayload = JSON.parse(cleared.stdout);
  assert.equal(clearedPayload.fallbackModel, null);
  assert.match(clearedPayload.actionsTaken.join("\n"), /Cleared the configured fallback model/);
  assert.equal(getConfig(repo).fallbackModel, null);
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

function setupDeepReviewRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  return { repo, binDir, statePath: path.join(binDir, "fake-codex-state.json") };
}

test("deep-review defaults to gpt-5.6-sol at high effort", () => {
  const { repo, binDir, statePath } = setupDeepReviewRepo();

  const result = run("node", [SCRIPT, "deep-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Model: gpt-5\.6-sol$/m);
  assert.match(result.stdout, /^Effort: high$/m);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastTurnStart.model, "gpt-5.6-sol");
  assert.equal(state.lastTurnStart.effort, "high");
});

test("deep-review honors explicit --model and --effort overrides", () => {
  const { repo, binDir, statePath } = setupDeepReviewRepo();

  const result = run(
    "node",
    [SCRIPT, "deep-review", "--model", "gpt-5.6-terra", "--effort", "low"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Model: gpt-5\.6-terra$/m);
  // Deliberately not `high`: that is now the deep-review default, so an
  // override test that asked for it could pass without the flag taking effect.
  assert.match(result.stdout, /^Effort: low$/m);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastTurnStart.model, "gpt-5.6-terra");
  assert.equal(state.lastTurnStart.effort, "low");
});

test("adversarial-review reports the default model and Codex-selected effort", () => {
  const { repo, binDir } = setupDeepReviewRepo();

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Model: gpt-5\.5$/m);
  assert.match(result.stdout, /^Effort: codex default$/m);
});

test("native review reports the default model without effort attribution", () => {
  const { repo, binDir } = setupDeepReviewRepo();

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Model: gpt-5\.5$/m);
  assert.doesNotMatch(result.stdout, /^Effort:/m);
});

test("deep-review JSON reports the resolved model and effort", () => {
  const { repo, binDir } = setupDeepReviewRepo();

  const result = run("node", [SCRIPT, "deep-review", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "gpt-5.6-sol");
  assert.equal(payload.effort, "high");
});

test("native review rejects --effort instead of silently ignoring it", () => {
  const { repo, binDir } = setupDeepReviewRepo();

  const result = run("node", [SCRIPT, "review", "--effort", "high"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native `review` command does not support `--effort`/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastTurnStart.sandboxPolicy?.type, "readOnly");
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

test("transfer recovers the transcript when the session moved into a worktree project dir", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-moved-into-worktree";
  fs.mkdirSync(repo, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  const stalePath = path.join(home, ".claude", "projects", "-repo", `${sessionId}.jsonl`);
  const worktreeProjectDir = path.join(home, ".claude", "projects", "-repo--worktrees-feature");
  const actualPath = path.join(worktreeProjectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  fs.mkdirSync(worktreeProjectDir, { recursive: true });
  fs.writeFileSync(
    actualPath,
    [
      { type: "custom-title", customTitle: "Worktree transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: stalePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sourcePath, fs.realpathSync(actualPath));
  assert.equal(payload.sessionId, sessionId);
});

test("transfer refuses to guess when the recorded session id matches several transcripts", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-ambiguous";
  fs.mkdirSync(repo, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  const stalePath = path.join(home, ".claude", "projects", "-repo", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  for (const projectDir of ["-repo--worktrees-a", "-repo--worktrees-b"]) {
    const dir = path.join(home, ".claude", "projects", projectDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n", "utf8");
  }

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: stalePath
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--source/);
});

test("transfer rejects recovered transcripts outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-recovered-outside-projects";
  const stalePath = path.join(home, ".claude", "projects", "-repo", `${sessionId}.jsonl`);
  const recoveredPath = path.join(
    home,
    ".claude",
    "projects",
    "-repo--worktrees-outside",
    `${sessionId}.jsonl`
  );
  const outsidePath = path.join(home, "outside-session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  fs.mkdirSync(path.dirname(recoveredPath), { recursive: true });
  fs.writeFileSync(outsidePath, "{}\n", "utf8");
  fs.symlinkSync(outsidePath, recoveredPath);
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: stalePath
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex can import Claude sessions only from .*\.claude.*projects/);
});

test("transfer does not search when the source is explicit", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const sessionId = "sess-explicit-source";
  const stalePath = path.join(home, ".claude", "projects", "-repo", `${sessionId}.jsonl`);
  const actualPath = path.join(home, ".claude", "projects", "-repo--worktrees-feature", `${sessionId}.jsonl`);
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  fs.mkdirSync(path.dirname(actualPath), { recursive: true });
  fs.writeFileSync(actualPath, "{}\n", "utf8");

  const previousHome = process.env.HOME;
  const previousTranscriptPath = process.env[TRANSCRIPT_PATH_ENV];
  try {
    process.env.HOME = home;
    process.env[TRANSCRIPT_PATH_ENV] = actualPath;
    assert.throws(
      () => resolveClaudeSessionPath(repo, { source: stalePath }),
      new Error(`Claude session file not found: ${stalePath}`)
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousTranscriptPath === undefined) {
      delete process.env[TRANSCRIPT_PATH_ENV];
    } else {
      process.env[TRANSCRIPT_PATH_ENV] = previousTranscriptPath;
    }
  }
});

test("transfer keeps the missing-file error when no matching transcript exists", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const sessionId = "sess-no-candidate";
  const stalePath = path.join(home, ".claude", "projects", "-repo", `${sessionId}.jsonl`);
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });

  const previousHome = process.env.HOME;
  const previousTranscriptPath = process.env[TRANSCRIPT_PATH_ENV];
  try {
    process.env.HOME = home;
    process.env[TRANSCRIPT_PATH_ENV] = stalePath;
    assert.throws(
      () => resolveClaudeSessionPath(repo),
      new Error(`Claude session file not found: ${stalePath}`)
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousTranscriptPath === undefined) {
      delete process.env[TRANSCRIPT_PATH_ENV];
    } else {
      process.env[TRANSCRIPT_PATH_ENV] = previousTranscriptPath;
    }
  }
});

test("transfer lists all matching transcript paths when recovery is ambiguous", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const sessionId = "sess-ambiguous-unit";
  const stalePath = path.join(home, ".claude", "projects", "-repo", `${sessionId}.jsonl`);
  const candidatePaths = [
    path.join(home, ".claude", "projects", "-repo--worktrees-a", `${sessionId}.jsonl`),
    path.join(home, ".claude", "projects", "-repo--worktrees-b", `${sessionId}.jsonl`)
  ];
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  for (const candidatePath of candidatePaths) {
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, "{}\n", "utf8");
  }

  const previousHome = process.env.HOME;
  const previousTranscriptPath = process.env[TRANSCRIPT_PATH_ENV];
  try {
    process.env.HOME = home;
    process.env[TRANSCRIPT_PATH_ENV] = stalePath;
    assert.throws(() => resolveClaudeSessionPath(repo), (error) => {
      assert.match(error.message, /matched several transcripts/);
      assert.match(error.message, /--source/);
      for (const candidatePath of candidatePaths) {
        assert.ok(error.message.includes(candidatePath));
      }
      return true;
    });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousTranscriptPath === undefined) {
      delete process.env[TRANSCRIPT_PATH_ENV];
    } else {
      process.env[TRANSCRIPT_PATH_ENV] = previousTranscriptPath;
    }
  }
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("classifyFailureMessage recognizes capacity failures conservatively", () => {
  const capacityMessages = [
    "The selected model is at capacity.",
    "The selected model is overloaded.",
    "The selected model is currently overloaded.",
    "Try a different model and retry the request."
  ];
  for (const message of capacityMessages) {
    assert.deepEqual(classifyFailureMessage(message), {
      failureClass: "capacity",
      retryable: true
    }, message);
  }

  const ordinaryMessages = [
    "Authentication expired.",
    "Capacity planning is unavailable.",
    "The request overloaded the worker.",
    "Try another model."
  ];
  for (const message of ordinaryMessages) {
    assert.deepEqual(classifyFailureMessage(message), {
      failureClass: null,
      retryable: false
    }, message);
  }

  for (const value of [null, undefined, 42, { message: "The selected model is at capacity." }]) {
    assert.deepEqual(classifyFailureMessage(value), {
      failureClass: null,
      retryable: false
    });
  }
});

test("fallback model resolution honors env, config, discovery, and none precedence", async () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  setConfig(repo, "fallbackModel", "configured-backup");

  let modelListCalls = 0;
  const client = {
    async request(method) {
      assert.equal(method, "model/list");
      modelListCalls += 1;
      return {
        data: [
          { model: "hidden-default", hidden: true, isDefault: true },
          { model: "discovered-first", hidden: false, isDefault: false },
          { model: "discovered-default", hidden: false, isDefault: true }
        ],
        nextCursor: null
      };
    }
  };

  assert.equal(
    await resolveFallbackModel(client, {
      failedModel: "failed-model",
      workspaceRoot: repo,
      env: { CODEX_COMPANION_FALLBACK_MODEL: "env-backup" }
    }),
    "env-backup"
  );
  assert.equal(modelListCalls, 0);

  assert.equal(
    await resolveFallbackModel(client, { failedModel: "failed-model", workspaceRoot: repo, env: {} }),
    "configured-backup"
  );
  assert.equal(modelListCalls, 0);

  assert.equal(
    await resolveFallbackModel(client, {
      failedModel: "failed-model",
      workspaceRoot: repo,
      env: { CODEX_COMPANION_FALLBACK_MODEL: "NoNe" }
    }),
    null
  );
  assert.equal(modelListCalls, 0);

  setConfig(repo, "fallbackModel", null);
  assert.equal(
    await resolveFallbackModel(client, { failedModel: "failed-model", workspaceRoot: repo, env: {} }),
    "discovered-default"
  );
  assert.equal(modelListCalls, 1);

  assert.equal(
    await resolveFallbackModel(client, { failedModel: "discovered-default", workspaceRoot: repo, env: {} }),
    "discovered-first"
  );
  assert.equal(modelListCalls, 2);
});

test("a capacity rejection retries on the designated backup model", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-at-capacity");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "summarize the repo", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_FALLBACK_MODEL: "gpt-5.6-terra" }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.modelFallback.from, "gpt-5.5");
  assert.equal(payload.modelFallback.to, "gpt-5.6-terra");
  assert.equal(payload.modelFallback.reason, "capacity");

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.capacityRejections, 1);
  assert.equal(state.lastTurnStart.model, "gpt-5.6-terra");
});

test("a capacity rejection with no designated backup model reports a retryable failure class", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-at-capacity");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // No backup model designated and model discovery disabled, so the run has
  // nowhere to fall back to and must say why in a machine-readable way.
  const result = run("node", [SCRIPT, "task", "summarize the repo", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_FALLBACK_MODEL: "none" }
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureClass, "capacity");
  assert.equal(payload.retryable, true);
});

test("a failing capacity fallback runs only once and remains retryable", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "all-models-at-capacity");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "summarize the repo", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_FALLBACK_MODEL: "gpt-5.6-terra" }
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureClass, "capacity");
  assert.equal(payload.retryable, true);
  assert.deepEqual(payload.modelFallback, {
    from: "gpt-5.5",
    to: "gpt-5.6-terra",
    reason: "capacity"
  });

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.capacityRejections, 2);
  assert.equal(state.lastTurnStart.model, "gpt-5.6-terra");

  const companionState = JSON.parse(
    fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8")
  );
  const jobLog = fs.readFileSync(companionState.jobs[0].logFile, "utf8");
  assert.match(jobLog, /Model gpt-5\.5 is at capacity; retrying on gpt-5\.6-terra\./);
});

test("a capacity fallback failure reports the fallback turn's non-capacity error", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "capacity-then-auth-failure");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "summarize the repo", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_FALLBACK_MODEL: "gpt-5.6-terra" }
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureClass, null);
  assert.equal(payload.retryable, false);
  assert.match(payload.failureMessage, /Authentication expired; run codex login/);
  assert.deepEqual(payload.modelFallback, {
    from: "gpt-5.5",
    to: "gpt-5.6-terra",
    reason: "capacity"
  });

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.capacityRejections, 1);
  assert.equal(state.turnStarts, 2);
});

test("a capacity failure after a command starts does not retry", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-at-capacity-after-command-start");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "apply the change", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_FALLBACK_MODEL: "gpt-5.6-terra" }
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureClass, "capacity");
  assert.equal(payload.retryable, true);
  assert.equal(payload.modelFallback, null);

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.capacityRejections, 1);
  assert.equal(state.turnStarts, 1);
  assert.equal(state.lastTurnStart.model, "gpt-5.5");
});

test("a capacity failure after producing output does not retry", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-at-capacity-after-output");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "summarize the repo", "--json"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_FALLBACK_MODEL: "gpt-5.6-terra" }
  });

  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.failureClass, "capacity");
  assert.equal(payload.retryable, true);
  assert.equal(payload.modelFallback, null);

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.capacityRejections, 1);
  assert.equal(state.lastTurnStart.model, "gpt-5.5");
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(state.lastThreadStart.model, "gpt-5.5");
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("deep review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "deep-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deep Review/);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("deep review sends the deep-review prompt covering all three dimensions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "deep-review", "focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /Correctness/);
  assert.match(state.lastTurnStart.prompt, /Conciseness/);
  assert.match(state.lastTurnStart.prompt, /Code quality/);
  assert.match(state.lastTurnStart.prompt, /focus on auth/);
});

test("deep-review focus text as a single raw argv element keeps a hyphen-leading token literal", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "deep-review", "focus on the --dry-run path"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /focus on the --dry-run path/);
});

test("deep-review warns on stderr when a declared flag lands after the focus text, but still reviews the working tree (issue #46 round 2)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "deep-review", "focus on retries --base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^\[codex\] --base came after the prompt text, so it is kept as literal text/m);

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /focus on retries --base main/);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task --resume-id resumes the exact thread it names", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "--json", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);
  const firstPayload = JSON.parse(firstRun.stdout);
  const threadId = firstPayload.threadId;
  assert.ok(threadId);

  const result = run("node", [SCRIPT, "task", "--resume-id", threadId, "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task --resume-id combined with --fresh errors", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--resume-id", "thr_123", "--fresh", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--resume-id or --fresh/);
});

test("task --resume-id combined with --resume-last errors", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--resume-id", "thr_123", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--resume-id or --resume\/--resume-last/);
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --wait sends the prompt without prepending the flag (issue #46)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--wait", "do the thing"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "do the thing");
});

test("task rejects --prompt-file with an inline prompt before starting a turn (issue #52)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "plan.md"), "do the thing\n");

  const result = run("node", [SCRIPT, "task", "--prompt-file", "plan.md", "and also check retries"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Choose either --prompt-file or an inline prompt, not both; the prompt file is read verbatim, so text after it would be discarded\./
  );
  assert.equal(fs.existsSync(statePath), false);
});

test("task --prompt-file sends the file contents when no inline prompt is given", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "plan.md"), "do the thing\n");

  const result = run("node", [SCRIPT, "task", "--prompt-file", "plan.md"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "do the thing");
});

test("task --prompt-file conflict does not emit a literal-text warning for flag-like inline text", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  fs.writeFileSync(path.join(repo, "plan.md"), "do the thing\n");

  const result = run("node", [SCRIPT, "task", "--prompt-file", "plan.md", "text --wait more"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Choose either --prompt-file or an inline prompt, not both; the prompt file is read verbatim, so text after it would be discarded\./
  );
  assert.doesNotMatch(result.stderr, /kept as literal text/);
  assert.equal(fs.existsSync(statePath), false);
});

test("task --help prints task usage without starting a turn or registering a job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--help"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Usage:\n  node scripts/codex-companion.mjs task [--wait|--background] [--write] [--resume-last|--resume|--resume-id <threadId>|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [prompt]\n");
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(resolveStateDir(repo)), false);
});

test("task prompt followed by --help as separate argv elements prints task usage without starting a turn or registering a job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "do the thing", "--help"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Usage:\n  node scripts/codex-companion.mjs task [--wait|--background] [--write] [--resume-last|--resume|--resume-id <threadId>|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [prompt]\n");
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(resolveStateDir(repo)), false);
});

test("transfer consumes --help as the --source value instead of printing usage", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "transfer", "--source", "--help"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /^Usage:/);
  assert.match(result.stderr, /Claude session source must be a JSONL file: .*--help/);
});

test("help scanning skips values for declared options in prose subcommands", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const cases = [
    ["task", ["--model", "gpt-5.5", "--help"], "task"],
    ["task", ["-C", "/tmp", "--help"], "task"],
    ["review", ["--base", "main", "--help"], "review"],
    ["task", ["--model=gpt-5.5", "--help"], "task"]
  ];

  for (const [subcommand, args, usageSubcommand] of cases) {
    const result = run("node", [SCRIPT, subcommand, ...args], {
      cwd: repo,
      env: buildEnv(binDir)
    });

    assert.equal(result.status, 0, `${subcommand} ${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`^Usage:\\n  node scripts/codex-companion\\.mjs ${usageSubcommand} `));
    assert.equal(result.stderr, "");
  }
});

test("unknown subcommand --help remains an error", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "bogus", "--help"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown subcommand: bogus/);
  assert.doesNotMatch(result.stdout, /^Usage:/);
});

test("subcommand --help prints only that subcommand's usage", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const cases = [
    ["status", "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]"],
    ["deep-review", "  node scripts/codex-companion.mjs deep-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [focus text]"],
    ["cancel", "  node scripts/codex-companion.mjs cancel [job-id] [--json]"]
  ];

  for (const [subcommand, usage] of cases) {
    const result = run("node", [SCRIPT, subcommand, "--help"], {
      cwd: repo,
      env: buildEnv(binDir)
    });

    assert.equal(result.status, 0, `${subcommand}: ${result.stderr}`);
    assert.equal(result.stdout, `Usage:\n${usage}\n`);
    assert.equal(result.stderr, "");
  }
});

test("job-id subcommand --help prints only that subcommand's usage", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const cases = [
    ["status", "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]"],
    ["result", "  node scripts/codex-companion.mjs result [job-id] [--json]"],
    ["cancel", "  node scripts/codex-companion.mjs cancel [job-id] [--json]"]
  ];

  for (const [subcommand, usage] of cases) {
    const result = run("node", [SCRIPT, subcommand, "abc", "--help"], {
      cwd: repo,
      env: buildEnv(binDir)
    });

    assert.equal(result.status, 0, `${subcommand}: ${result.stderr}`);
    assert.equal(result.stdout, `Usage:\n${usage}\n`);
    assert.equal(result.stderr, "");
  }
});

test("job-id subcommand bare -- stops help scanning", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "status", "abc", "--", "--help"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /^Usage:/);
});

test("task -- --help keeps the escape hatch prompt literal", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--", "--help"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "--help");
  assert.doesNotMatch(result.stdout, /^Usage:/);
});

test("task -- keeps a flag-looking prompt literal and read-only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--", "--write", "access", "is", "missing", "in", "prod"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "--write access is missing in prod");
  assert.equal(fakeState.lastTurnStart.sandboxPolicy?.type, "readOnly");
});

test("single-string task prose containing --help stays literal", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "fix the --help flag"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "fix the --help flag");
  assert.doesNotMatch(result.stdout, /^Usage:/);
});

test("task prompt as a single raw argv element keeps hyphen-leading words literal (issue #46 regression)", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "fix the --wait bug"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  // "--wait" is a declared flag on task, but it is buried mid-prose (not the
  // last or second-to-last positional), so this must NOT trip the round-2
  // trailing-flag warning -- prompts routinely discuss flag names in passing.
  assert.doesNotMatch(result.stderr, /came after the prompt text/);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "fix the --wait bug");
});

test("task prompt as a single raw argv element does not crash on an unknown-looking flag", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "add a --dry-run mode"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "add a --dry-run mode");
});

test("task applies trailing --json after a multi-element prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do the thing", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  JSON.parse(result.stdout);
  assert.doesNotMatch(result.stderr, /^\[codex\]/m);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "do the thing");
});

test("task keeps --json literal when it arrives inside a single raw prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "do the thing --json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^\[codex\] --json came after the prompt text, so it is kept as literal text/m);
  assert.doesNotMatch(result.stdout, /^\{/);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "do the thing --json");
});

test("task rejects --wait and --background together", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "task", "--wait", "--background", "do the thing"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Choose either --wait or --background\./);
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CODEX_COMPANION_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("session start hook keeps the shared CLAUDE_PLUGIN_DATA untouched for other plugins", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: path.join(repo, "session.jsonl"),
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  const contents = fs.readFileSync(envFile, "utf8");
  assert.equal(/^export CLAUDE_PLUGIN_DATA=/m.test(contents), false, contents);
  assert.match(contents, new RegExp(`^export CODEX_COMPANION_PLUGIN_DATA='${pluginDataDir}'$`, "m"));
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("write task in linked worktree passes the git common dir as an extra writable root", () => {
  const repo = makeTempDir();
  const worktreeParent = makeTempDir();
  const worktree = path.join(worktreeParent, "linked-worktree");
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  try {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    run("git", ["add", "README.md"], { cwd: repo });
    run("git", ["commit", "-m", "init"], { cwd: repo });
    run("git", ["worktree", "add", "-b", "linked-runtime-test", worktree], { cwd: repo });

    const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
      cwd: worktree,
      env: buildEnv(binDir)
    });

    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.lastTurnStart.sandboxPolicy?.type, "workspaceWrite");
    assert.deepEqual(state.lastThreadStart.config?.["sandbox_workspace_write.writable_roots"], [
      fs.realpathSync(path.join(repo, ".git"))
    ]);

    const resume = run("node", [SCRIPT, "task", "--resume", "--write", "follow up"], {
      cwd: worktree,
      env: buildEnv(binDir)
    });

    assert.equal(resume.status, 0, resume.stderr);
    const resumedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(resumedState.lastTurnStart.sandboxPolicy?.type, "workspaceWrite");
    assert.deepEqual(resumedState.lastThreadResume.config?.["sandbox_workspace_write.writable_roots"], [
      fs.realpathSync(path.join(repo, ".git"))
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(worktreeParent, { recursive: true, force: true });
  }
});

test("write task in normal checkout does not add writable root config", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastThreadStart.config, undefined);
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.sandboxPolicy?.type, "readOnly");
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.5");
  assert.equal(fakeState.lastTurnStart.effort, "high");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task accepts max and ultra efforts and rejects invalid efforts", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  for (const effort of ["max", "ultra"]) {
    const result = run("node", [SCRIPT, "task", "--model", "gpt-5.6-sol", "--effort", effort, `reply ${effort}`], {
      cwd: repo,
      env: buildEnv(binDir)
    });

    assert.equal(result.status, 0, `${effort}: ${result.stderr}`);
    const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(fakeState.lastTurnStart.model, "gpt-5.6-sol");
    assert.equal(fakeState.lastTurnStart.effort, effort);
  }

  const invalid = run("node", [SCRIPT, "task", "--effort", "insane", "reply no"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(invalid.status, 0);
  assert.match(
    invalid.stderr,
    /Unsupported reasoning effort "insane"\. Use one of: none, minimal, low, medium, high, xhigh, max, ultra\./
  );
});

function setupEffortRepo(behavior = "review-ok") {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, statePath };
}

test("task warns when the resolved model does not advertise the requested effort", () => {
  const { repo, binDir, statePath } = setupEffortRepo();

  // gpt-5.6-luna advertises up to `max`; `ultra` is accepted by the flat syntax
  // gate but is not a level this model offers. The run must still proceed, but
  // the caller has to be told the effort it asked for is not on the menu.
  const result = run("node", [SCRIPT, "task", "--model", "gpt-5.6-luna", "--effort", "ultra", "reply ultra"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /gpt-5\.6-luna/);
  assert.match(result.stderr, /does not advertise reasoning effort "ultra"/);
  assert.match(result.stderr, /low, medium, high, xhigh, max/);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.effort, "ultra");
});

test("task warns when the resolved model is found through paginated model/list responses", () => {
  const { repo, binDir, statePath } = setupEffortRepo("model-list-paginated");

  const result = run("node", [SCRIPT, "task", "--model", "gpt-5.6-luna", "--effort", "ultra", "reply ultra"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /gpt-5\.6-luna/);
  assert.match(result.stderr, /does not advertise reasoning effort "ultra"/);
  assert.match(result.stderr, /low, medium, high, xhigh, max/);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.effort, "ultra");
});

test("task stays quiet when the resolved model advertises the requested effort", () => {
  const { repo, binDir } = setupEffortRepo();

  const result = run("node", [SCRIPT, "task", "--model", "gpt-5.6-luna", "--effort", "max", "reply max"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /does not advertise reasoning effort/);
});

test("task effort validation fails open when the app-server cannot list models", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "model-list-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // An older app-server without model/list must not break the run or produce a
  // warning we cannot substantiate.
  const result = run("node", [SCRIPT, "task", "--model", "gpt-5.6-luna", "--effort", "ultra", "reply ultra"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /does not advertise reasoning effort/);
});

test("task does not query model/list when no effort override was requested", () => {
  const { repo, binDir, statePath } = setupEffortRepo();

  const result = run("node", [SCRIPT, "task", "reply default"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.modelListCalls ?? 0, 0);
});

test("deep-review warns when its model does not advertise the requested effort", () => {
  const { repo, binDir } = setupDeepReviewRepo();

  const result = run("node", [SCRIPT, "deep-review", "--model", "gpt-5.5", "--effort", "max"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /gpt-5\.5 does not advertise reasoning effort "max"/);
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task infers completion when a tool errors after the final answer", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "errored-tool-after-final-answer");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "review one last optional tool result"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_TURN_STALL_TIMEOUT_MS: "5000",
      CODEX_TOOL_STALL_TIMEOUT_MS: "500"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  assert.match(result.stderr, /Codex error: codegraph_explore failed before returning results/);
  assert.match(result.stderr, /Turn completion inferred after the main thread finished and subagent work drained\./);
});

test("task infers completion when a tool item completes with an error after the final answer", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "errored-tool-completion-after-final-answer");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "review one last optional tool result"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_TURN_STALL_TIMEOUT_MS: "5000",
      CODEX_TOOL_STALL_TIMEOUT_MS: "500"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  assert.match(result.stderr, /Tool codegraph\/codegraph_explore failed\./);
  assert.match(result.stderr, /Turn completion inferred after the main thread finished and subagent work drained\./);
});

test("task using the shared broker still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("task-worker remains an alias for the job worker", async () => {
  const repo = makeTempDir();
  const jobId = `task-alias-${Date.now().toString(36)}`;
  const child = spawn(
    process.execPath,
    [SCRIPT, "task-worker", "--cwd", repo, "--job-id", jobId],
    { cwd: repo, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  const queuedJob = {
    id: jobId,
    workspaceRoot: repo,
    status: "queued",
    phase: "queued",
    pid: child.pid,
    pidStartTime: null
  };
  writeJobFile(repo, jobId, queuedJob);
  upsertJob(repo, queuedJob);

  const result = await waitForChildExit(child, 15000);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /missing its job request payload/);
});

test("task --background handshakes queued persistence before releasing its worker", async (t) => {
  if (process.platform === "win32") {
    t.skip("uses the POSIX process-start-time probe");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const probeDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  ensureStateDir(repo);
  const parentProbeStarted = path.join(probeDir, "parent-started");
  const parentProbeRelease = path.join(probeDir, "parent-release");
  const parentProbeLock = path.join(probeDir, "parent-lock");
  const lockOwnerProbeLock = path.join(probeDir, "lock-owner-lock");
  const workerProbeStarted = path.join(probeDir, "worker-started");
  const workerProbeRelease = path.join(probeDir, "worker-release");
  const workerProbeLock = path.join(probeDir, "worker-lock");
  writeExecutable(
    path.join(probeDir, "ps"),
    [
      "#!/bin/sh",
      "# Keep state-lock owner probes separate from the parent/worker handshake probes.",
      'if mkdir "$CODEX_TEST_PARENT_PROBE_LOCK" 2>/dev/null; then',
      '  printf \'started\\n\' > "$CODEX_TEST_PARENT_PROBE_STARTED"',
      '  while [ ! -e "$CODEX_TEST_PARENT_PROBE_RELEASE" ]; do sleep 0.01; done',
      'elif mkdir "$CODEX_TEST_LOCK_OWNER_PROBE_LOCK" 2>/dev/null; then',
      "  :",
      'elif mkdir "$CODEX_TEST_WORKER_PROBE_LOCK" 2>/dev/null; then',
      '  printf \'started\\n\' > "$CODEX_TEST_WORKER_PROBE_STARTED"',
      '  while [ ! -e "$CODEX_TEST_WORKER_PROBE_RELEASE" ]; do sleep 0.01; done',
      "fi",
      "printf 'Mon Jul 27 12:34:56 2026\\n'"
    ].join("\n") + "\n"
  );

  const baseEnv = buildEnv(binDir);
  const env = {
    ...baseEnv,
    PATH: `${probeDir}:${baseEnv.PATH}`,
    CODEX_TEST_PARENT_PROBE_LOCK: parentProbeLock,
    CODEX_TEST_PARENT_PROBE_STARTED: parentProbeStarted,
    CODEX_TEST_PARENT_PROBE_RELEASE: parentProbeRelease,
    CODEX_TEST_LOCK_OWNER_PROBE_LOCK: lockOwnerProbeLock,
    CODEX_TEST_WORKER_PROBE_LOCK: workerProbeLock,
    CODEX_TEST_WORKER_PROBE_STARTED: workerProbeStarted,
    CODEX_TEST_WORKER_PROBE_RELEASE: workerProbeRelease
  };
  const child = spawn(process.execPath, [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const launchPromise = waitForChildExit(child, 15000);
  t.after(async () => {
    for (const release of [parentProbeRelease, workerProbeRelease]) {
      if (!fs.existsSync(release)) {
        fs.writeFileSync(release, "");
      }
    }
    await launchPromise.catch(() => {});
  });

  await waitFor(() => fs.existsSync(parentProbeStarted), { timeoutMs: 1500, intervalMs: 10 });
  assert.equal(fs.existsSync(parentProbeRelease), false);
  assert.equal(fs.existsSync(workerProbeStarted), false);
  const placeholder = await waitFor(
    () => {
      try {
        const jobFiles = fs.readdirSync(jobsDir).filter((file) => file.endsWith(".json"));
        if (jobFiles.length !== 1) {
          return null;
        }
        const jobFile = path.join(jobsDir, jobFiles[0]);
        const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
        return { jobFile, job };
      } catch {
        return null;
      }
    },
    { timeoutMs: 1500, intervalMs: 10 }
  );
  assert.equal(placeholder.job.status, "starting");
  assert.equal(placeholder.job.phase, "starting");
  assert.equal(placeholder.job.pid, null);
  assert.equal(placeholder.job.pidStartTime, null);
  assert.ok(placeholder.job.request);
  assert.equal(fs.existsSync(path.join(stateDir, "state.json")), false);

  fs.writeFileSync(parentProbeRelease, "");
  await waitFor(() => fs.existsSync(workerProbeStarted), { timeoutMs: 1500, intervalMs: 10 });
  const ready = await waitFor(
    () => {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
        const stateJob = state.jobs?.find((candidate) => candidate.id === placeholder.job.id);
        const storedJob = JSON.parse(fs.readFileSync(placeholder.jobFile, "utf8"));
        if (
          stateJob?.status !== "queued" ||
          storedJob.status !== "queued" ||
          stateJob.pid !== storedJob.pid ||
          typeof storedJob.pid !== "number"
        ) {
          return null;
        }
        return { stateJob, storedJob };
      } catch {
        return null;
      }
    },
    { timeoutMs: 1500, intervalMs: 10 }
  );
  assert.equal(ready.stateJob.pidStartTime, "Mon Jul 27 12:34:56 2026");
  assert.equal(ready.storedJob.pidStartTime, "Mon Jul 27 12:34:56 2026");

  const launched = await launchPromise;
  assert.equal(launched.code, 0, launched.stderr);

  fs.writeFileSync(workerProbeRelease, "");
  const runningJob = await waitFor(
    () => {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
        const job = state.jobs?.find((candidate) => candidate.id === placeholder.job.id);
        return job?.status === "running" ? job : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 5000, intervalMs: 25 }
  );
  assert.equal(runningJob.pid, ready.stateJob.pid);

  const completedJob = await waitFor(
    () => {
      try {
        const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
        const job = state.jobs?.find((candidate) => candidate.id === placeholder.job.id);
        return job?.status === "completed" ? job : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 10000, intervalMs: 25 }
  );
  assert.equal(completedJob.pid, null);
  assert.equal(completedJob.pidStartTime, "Mon Jul 27 12:34:56 2026");

  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(repo, placeholder.job.id), "utf8"));
  assert.equal(storedJob.status, "completed");
  assert.equal(storedJob.pid, null);
  assert.equal(storedJob.pidStartTime, "Mon Jul 27 12:34:56 2026");
});

test("task records a signal-specific failure before exiting on SIGTERM", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const child = spawn(process.execPath, [SCRIPT, "task", "--json", "keep working until interrupted"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const waitForExit = (timeoutMs, message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      exited.then(
        (exit) => {
          clearTimeout(timer);
          resolve(exit);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    try {
      await waitForExit(5000, "child did not exit after SIGKILL during cleanup").catch(() => {});
    } finally {
      const session = loadBrokerSession(repo);
      if (session?.endpoint) {
        await sendBrokerShutdown(session.endpoint).catch(() => {});
      }
    }
  });

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const stateFile = path.join(stateDir, "state.json");
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    const serializedState = fs.readFileSync(stateFile, "utf8");
    let state;
    try {
      state = JSON.parse(serializedState);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
    return state.jobs.find(
      (job) => job.status === "running" && job.threadId && job.turnId
    ) ?? null;
  }, { timeoutMs: 15000 });

  child.kill("SIGTERM");
  const exit = await waitForExit(
    10000,
    "child did not exit after SIGTERM — the signal handler did not re-raise"
  );
  assert.equal(exit.code, null);
  assert.equal(exit.signal, "SIGTERM");

  const storedJob = JSON.parse(
    fs.readFileSync(resolveJobFile(repo, runningJob.id), "utf8")
  );
  assert.equal(storedJob.status, "failed");
  assert.equal(storedJob.phase, "failed");
  assert.equal(storedJob.pid, null);
  assert.equal(storedJob.errorMessage, "Job terminated by signal SIGTERM.");
  assert.ok(storedJob.completedAt);
  assert.equal(storedJob.threadId, runningJob.threadId);
  assert.equal(storedJob.turnId, runningJob.turnId);
  assert.match(fs.readFileSync(storedJob.logFile, "utf8"), /signal SIGTERM/i);
});

test("task watchdog interrupts a hung tool turn and fails the job instead of hanging", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "hung-tool");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "5000",
    CODEX_TOOL_STALL_TIMEOUT_MS: "500"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the hung MCP tool"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "250", "--json"],
    {
      cwd: repo,
      env
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.match(
    fs.readFileSync(waitedPayload.job.logFile, "utf8"),
    /Codex turn stalled \(tool-in-flight\)/,
    "expected the tool budget to fire, not the turn backstop"
  );
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "failed");

  const fakeState = await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return null;
    }
    const current = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return current.lastInterrupt ? current : null;
  });
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: waitedPayload.job.threadId,
    turnId: waitedPayload.job.turnId
  });

  const stored = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  assert.equal(storedPayload.job.status, "failed");
  assert.match(storedPayload.storedJob.rendered, /Codex turn stalled \(tool-in-flight\)/i);
  assert.match(storedPayload.storedJob.rendered, /codegraph_explore/i);
});

test("task watchdog caps a quick tool that stays busy but never completes", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "busy-quick-tool");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "8000",
    CODEX_TOOL_STALL_TIMEOUT_MS: "5000",
    CODEX_TOOL_MAX_INFLIGHT_MS: "800"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "run the chatty tool"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "250", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  // Fires on the wall-clock cap (800ms) even though the tool streams activity every 150ms, so the
  // inactivity budget (5000ms) never trips.
  assert.match(
    fs.readFileSync(waitedPayload.job.logFile, "utf8"),
    /Codex turn stalled \(tool-max-duration\)/,
    "expected the wall-clock cap to fire despite streaming"
  );
  assert.equal(waitedPayload.job.status, "failed");

  const fakeState = await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return null;
    }
    const current = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return current.lastInterrupt ? current : null;
  });
  assert.ok(fakeState.lastInterrupt, "expected the capped tool turn to be interrupted");

  const stored = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  assert.equal(storedPayload.job.status, "failed");
  assert.match(storedPayload.storedJob.rendered, /Codex turn stalled \(tool-max-duration\)/i);
  assert.match(storedPayload.storedJob.rendered, /exceeded max tool duration/i);
});

test("task watchdog lets a silent long-running command ride the turn backstop instead of the tool budget", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "silent-long-tool");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "8000",
    CODEX_TOOL_STALL_TIMEOUT_MS: "500",
    CODEX_TOOL_MAX_INFLIGHT_MS: "500"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "run the long silent command"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const startedAt = Date.now();
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "250", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const elapsedMs = Date.now() - startedAt;
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  // The command is silent for 1200ms — well past the 500ms quick-tool budget and the 500ms
  // wall-clock cap — yet completes successfully because a long tool uses neither.
  assert.equal(waitedPayload.job.status, "completed", waitedStatus.stdout);
  assert.ok(elapsedMs >= 1000, `expected long tool to survive past the short budgets, elapsed ${elapsedMs}ms`);

  assert.equal(fs.existsSync(fakeStatePath) && JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).lastInterrupt ? true : false, false,
    "a successful long command must not be interrupted");
});

test("task watchdog keeps a per-tool deadline when an overlapping tool completes", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "overlapping-quick-tools");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "8000",
    CODEX_TOOL_STALL_TIMEOUT_MS: "5000",
    CODEX_TOOL_MAX_INFLIGHT_MS: "800"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "run two overlapping tools"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "250", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.status, "failed");
  // Tool A's 800ms wall-clock cap must fire even though tool B completed first. If B's completion
  // had cleared A's deadline (the single-slot regression), A would instead ride the 5000ms tool
  // inactivity budget and report tool-in-flight, not tool-max.
  assert.match(
    fs.readFileSync(waitedPayload.job.logFile, "utf8"),
    /Codex turn stalled \(tool-max-duration\)/,
    "expected A's wall-clock cap to fire despite B completing"
  );
  const stored = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  assert.match(storedPayload.storedJob.rendered, /Codex turn stalled \(tool-max-duration\)/i);
  assert.match(storedPayload.storedJob.rendered, /codegraph_explore/i);
  assert.ok(fs.existsSync(fakeStatePath), "expected fake state to record the interrupt");
});

test("task does not infer success when a tool starts and hangs after the final answer", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "hung-tool-after-final-answer");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "8000",
    CODEX_TOOL_STALL_TIMEOUT_MS: "800"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "answer then hang on a tool"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "250", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  // A tool that starts after the final answer must block inferred completion; the turn fails via
  // the watchdog instead of racing to an inferred success.
  assert.equal(waitedPayload.job.status, "failed", waitedStatus.stdout);
  assert.match(
    fs.readFileSync(waitedPayload.job.logFile, "utf8"),
    /Codex turn stalled \(tool-in-flight\)/,
    "expected the tool budget to fire, not the turn backstop"
  );
  const stored = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  // The final answer was captured (so inference *could* have fired), yet the turn still failed
  // because the hung tool kept it from draining — that is the regression this guards.
  assert.equal(storedPayload.storedJob.status, "failed");
  assert.match(storedPayload.storedJob.rendered, /Handled the requested task/i);
});

test("task does not let a top-level error over one of two tools infer success", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "overlapping-error-after-final-answer");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "8000",
    CODEX_TOOL_STALL_TIMEOUT_MS: "800"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "two tools, one errors"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "250", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  // A top-level error with two overlapping tools must not clear the unrelated one or let inference
  // finalize success; the still-hung tool's watchdog fails the turn instead.
  assert.equal(waitedPayload.job.status, "failed", waitedStatus.stdout);
  assert.match(
    fs.readFileSync(waitedPayload.job.logFile, "utf8"),
    /Codex turn stalled \(tool-in-flight\)/,
    "expected the remaining tool's watchdog to fire, not the turn backstop"
  );
});

test("task does not infer completion when a tool errors before the final answer", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "errored-tool-before-final-answer");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "1000",
    CODEX_TOOL_STALL_TIMEOUT_MS: "300"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "try a tool before answering"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const startedAt = Date.now();
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env
    }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  assert.ok(elapsedMs >= 700, `expected idle backstop after errored tool, elapsed ${elapsedMs}ms`);
  assert.ok(elapsedMs < 10000);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "failed");

  const fakeState = await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return null;
    }
    const current = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return current.lastInterrupt ? current : null;
  });
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: waitedPayload.job.threadId,
    turnId: waitedPayload.job.turnId
  });

  const stored = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  assert.equal(storedPayload.job.status, "failed");
  assert.match(storedPayload.storedJob.rendered, /codegraph_explore failed before returning results/i);
  assert.doesNotMatch(storedPayload.storedJob.rendered, /while ".*codegraph_explore.*" was in flight/i);
});

test("task surfaces a failed tool item when completion errors before the final answer", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "errored-tool-completion-before-final-answer");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "1000",
    CODEX_TOOL_STALL_TIMEOUT_MS: "300"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "try a tool before answering"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const startedAt = Date.now();
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env
    }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  assert.ok(elapsedMs >= 700, `expected idle backstop after errored tool item, elapsed ${elapsedMs}ms`);
  assert.ok(elapsedMs < 10000);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "failed");

  const fakeState = await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return null;
    }
    const current = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return current.lastInterrupt ? current : null;
  });
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: waitedPayload.job.threadId,
    turnId: waitedPayload.job.turnId
  });

  const stored = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  assert.equal(storedPayload.job.status, "failed");
  assert.match(storedPayload.storedJob.rendered, /codegraph_explore failed from item completion/i);
  assert.doesNotMatch(storedPayload.storedJob.rendered, /Codex turn stalled \(tool-in-flight\)/i);
  assert.doesNotMatch(storedPayload.storedJob.rendered, /while ".*codegraph_explore.*" was in flight/i);
});

test("task watchdog lets idle reasoning exceed tool budget and stalls at turn backstop", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "idle-hung-turn");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "1500",
    CODEX_TOOL_STALL_TIMEOUT_MS: "300"
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "think without tools"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const startedAt = Date.now();
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env
    }
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  assert.ok(elapsedMs >= 1000, `expected idle turn to survive past tool budget, elapsed ${elapsedMs}ms`);
  assert.ok(elapsedMs < 10000);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "failed");

  const fakeState = await waitFor(() => {
    if (!fs.existsSync(fakeStatePath)) {
      return null;
    }
    const current = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return current.lastInterrupt ? current : null;
  });
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: waitedPayload.job.threadId,
    turnId: waitedPayload.job.turnId
  });

  const stored = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  assert.equal(storedPayload.job.status, "failed");
  assert.match(storedPayload.storedJob.rendered, /Codex turn stalled \(idle\)/i);
});

test("in-process idle watchdog reports measured oversleep and late firing", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "idle-hung-turn");
  initGitRepo(repo);

  const stallTimeoutMs = 100;
  const toolStallTimeoutMs = 50;
  const previousPath = process.env.PATH;
  const previousTurnStallTimeout = process.env.CODEX_TURN_STALL_TIMEOUT_MS;
  const previousToolStallTimeout = process.env.CODEX_TOOL_STALL_TIMEOUT_MS;
  process.env.PATH = buildEnv(binDir).PATH;
  process.env.CODEX_TURN_STALL_TIMEOUT_MS = String(stallTimeoutMs);
  process.env.CODEX_TOOL_STALL_TIMEOUT_MS = String(toolStallTimeoutMs);
  t.after(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    if (previousTurnStallTimeout === undefined) {
      delete process.env.CODEX_TURN_STALL_TIMEOUT_MS;
    } else {
      process.env.CODEX_TURN_STALL_TIMEOUT_MS = previousTurnStallTimeout;
    }
    if (previousToolStallTimeout === undefined) {
      delete process.env.CODEX_TOOL_STALL_TIMEOUT_MS;
    } else {
      process.env.CODEX_TOOL_STALL_TIMEOUT_MS = previousToolStallTimeout;
    }
  });

  let blockTimer = null;
  t.after(() => clearTimeout(blockTimer));

  const result = await runAppServerTurn(repo, {
    prompt: "think without tools",
    sandbox: "read-only",
    onProgress: (update) => {
      const message = typeof update === "string" ? update : update?.message;
      if (!blockTimer && message?.startsWith("Turn started")) {
        blockTimer = setTimeout(() => {
          const blockUntil = Date.now() + 1500;
          while (Date.now() < blockUntil) {
            // Deliberately starve the event loop past the watchdog deadline.
          }
        }, 50);
      }
    }
  });

  const failureMessage = result.error?.message ?? "";
  assert.notEqual(result.status, 0);
  assert.match(failureMessage, /Codex turn stalled \(idle\)/);
  const measured = failureMessage.match(/measured (\d+)(ms|s)/);
  assert.ok(measured, failureMessage);
  const measuredMs = Number(measured[1]) * (measured[2] === "s" ? 1000 : 1);
  assert.ok(measuredMs > stallTimeoutMs * 2, failureMessage);
  assert.match(failureMessage, /since the last of \d+ activity events at \d{4}-\d{2}-\d{2}T[^ ]+Z/);
  assert.match(failureMessage, /timer fired (\d+)(ms|s) late/);
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  assert.doesNotMatch(launched.stderr, /\[codex\] --background does not background/);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^review-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /No material issues found/);
});

test("review --background persists the resolved target in its job request", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "feature work"], { cwd: repo });

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(repo, launchPayload.jobId), "utf8"));
  assert.equal(storedJob.summary, "Review branch diff against main");
  assert.deepEqual(storedJob.request.target, {
    mode: "branch",
    label: "branch diff against main",
    baseRef: "main",
    explicit: false
  });

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  assert.equal(JSON.parse(waitedStatus.stdout).job.status, "completed");
});

test("review --background returns the workspace needed to wait and read from another cwd", async () => {
  const ambientCwd = makeTempDir();
  const repo = path.join(makeTempDir(), "repo with ' quote");
  const binDir = makeTempDir();
  fs.mkdirSync(repo);
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "review", "-C", repo, "--background", "--json"], {
    cwd: ambientCwd,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.workspaceRoot, fs.realpathSync(repo));

  const waitedStatus = run(
    "node",
    [
      SCRIPT,
      "status",
      "-C",
      launchPayload.workspaceRoot,
      launchPayload.jobId,
      "--wait",
      "--timeout-ms",
      "15000",
      "--json"
    ],
    { cwd: ambientCwd, env }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run(
      "node",
      [SCRIPT, "result", "-C", launchPayload.workspaceRoot, launchPayload.jobId, "--json"],
      { cwd: ambientCwd, env }
    );
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /No material issues found/);

  const renderedLaunch = run("node", [SCRIPT, "review", "-C", repo, "--background"], {
    cwd: ambientCwd,
    env
  });

  assert.equal(renderedLaunch.status, 0, renderedLaunch.stderr);
  const waitCommand = /^Block on it with: (.+)$/m.exec(renderedLaunch.stdout);
  assert.ok(waitCommand, renderedLaunch.stdout);
  const waitArgs = splitRawArgumentString(waitCommand[1]);
  assert.equal(waitArgs[0], "codex-companion.mjs");
  assert.equal(waitArgs[3], fs.realpathSync(repo));

  const renderedWait = run("node", [SCRIPT, ...waitArgs.slice(1)], {
    cwd: ambientCwd,
    env
  });

  assert.equal(renderedWait.status, 0, renderedWait.stderr);
  const renderedWaitPayload = JSON.parse(renderedWait.stdout);
  assert.equal(renderedWaitPayload.job.status, "completed");

  // The snapshot hint is a slash command, but /codex:status forwards its raw
  // arguments to this script, so it must carry the workspace too.
  const snapshotCommand = /^Snapshot without waiting: \/codex:status (.+)$/m.exec(renderedLaunch.stdout);
  assert.ok(snapshotCommand, renderedLaunch.stdout);
  const snapshotArgs = splitRawArgumentString(snapshotCommand[1]);
  assert.equal(snapshotArgs[1], fs.realpathSync(repo));

  const renderedSnapshot = run("node", [SCRIPT, "status", ...snapshotArgs, "--json"], {
    cwd: ambientCwd,
    env
  });

  assert.equal(renderedSnapshot.status, 0, renderedSnapshot.stderr);
  assert.equal(JSON.parse(renderedSnapshot.stdout).job.status, "completed");
});

test("deep-review --background enqueues a detached worker and stores its rendered result", async () => {
  const { repo, binDir } = setupDeepReviewRepo();
  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "deep-review", "--background", "--json"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^review-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /# Codex Deep Review/);
  assert.match(resultPayload.storedJob.rendered, /Missing empty-state guard/);
});

test("a background review reviews the target it was validated and named for", async (t) => {
  if (process.platform === "win32") {
    t.skip("uses the POSIX process-start-time probe to hold the worker");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const probeDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "feature work"], { cwd: repo });

  // The worker probes its own process start time before it runs the review, so
  // blocking `ps` there holds it between the parent's target resolution and its
  // own. The parent's probe is released up front; only the worker waits.
  const parentProbeLock = path.join(probeDir, "parent-lock");
  const parentProbeStarted = path.join(probeDir, "parent-started");
  const parentProbeRelease = path.join(probeDir, "parent-release");
  const lockOwnerProbeLock = path.join(probeDir, "lock-owner-lock");
  const workerProbeLock = path.join(probeDir, "worker-lock");
  const workerProbeStarted = path.join(probeDir, "worker-started");
  const workerProbeRelease = path.join(probeDir, "worker-release");
  writeExecutable(
    path.join(probeDir, "ps"),
    [
      "#!/bin/sh",
      'if mkdir "$CODEX_TEST_PARENT_PROBE_LOCK" 2>/dev/null; then',
      '  printf \'started\\n\' > "$CODEX_TEST_PARENT_PROBE_STARTED"',
      '  while [ ! -e "$CODEX_TEST_PARENT_PROBE_RELEASE" ]; do sleep 0.01; done',
      'elif mkdir "$CODEX_TEST_LOCK_OWNER_PROBE_LOCK" 2>/dev/null; then',
      "  :",
      'elif mkdir "$CODEX_TEST_WORKER_PROBE_LOCK" 2>/dev/null; then',
      '  printf \'started\\n\' > "$CODEX_TEST_WORKER_PROBE_STARTED"',
      '  while [ ! -e "$CODEX_TEST_WORKER_PROBE_RELEASE" ]; do sleep 0.01; done',
      "fi",
      "printf 'Mon Jul 27 12:34:56 2026\\n'"
    ].join("\n") + "\n"
  );
  fs.writeFileSync(parentProbeRelease, "");

  const baseEnv = buildEnv(binDir);
  const env = {
    ...baseEnv,
    PATH: `${probeDir}:${baseEnv.PATH}`,
    CODEX_TEST_PARENT_PROBE_LOCK: parentProbeLock,
    CODEX_TEST_PARENT_PROBE_STARTED: parentProbeStarted,
    CODEX_TEST_PARENT_PROBE_RELEASE: parentProbeRelease,
    CODEX_TEST_LOCK_OWNER_PROBE_LOCK: lockOwnerProbeLock,
    CODEX_TEST_WORKER_PROBE_LOCK: workerProbeLock,
    CODEX_TEST_WORKER_PROBE_STARTED: workerProbeStarted,
    CODEX_TEST_WORKER_PROBE_RELEASE: workerProbeRelease
  };
  t.after(() => {
    if (!fs.existsSync(workerProbeRelease)) {
      fs.writeFileSync(workerProbeRelease, "");
    }
  });

  // Clean tree, so `--scope auto` resolves to the branch diff and the job is
  // named for it.
  const launched = run("node", [SCRIPT, "adversarial-review", "--background", "--json"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.summary, "Adversarial Review branch diff against main");

  await waitFor(() => fs.existsSync(workerProbeStarted), { timeoutMs: 10000, intervalMs: 10 });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 3;\n");
  fs.writeFileSync(workerProbeRelease, "");

  // Every follow-up call keeps the probe on PATH: the worker recorded the
  // probe's start time, so a reaper reading the real `ps` would call it dead.
  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  assert.equal(JSON.parse(waitedStatus.stdout).job.status, "completed", waitedStatus.stdout);

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.storedJob.result.target.mode, "branch");
  assert.equal(resultPayload.storedJob.result.target.label, "branch diff against main");
  assert.match(resultPayload.storedJob.rendered, /^Target: branch diff against main$/m);

  // The label alone would still match if the worker reported the pinned target
  // while collecting different content, so assert what Codex actually received:
  // the enqueue-time branch diff, and none of the later working-tree edit.
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /export const value = 2;/);
  assert.doesNotMatch(state.lastTurnStart.prompt, /export const value = 3;/);
});

test("a background review refuses to review a repository that moved under its pinned target", async (t) => {
  if (process.platform === "win32") {
    t.skip("uses the POSIX process-start-time probe to hold the worker");
    return;
  }

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const probeDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  // Dirty tree, so `--scope auto` resolves and pins the working tree.
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");

  const parentProbeLock = path.join(probeDir, "parent-lock");
  const parentProbeStarted = path.join(probeDir, "parent-started");
  const parentProbeRelease = path.join(probeDir, "parent-release");
  const lockOwnerProbeLock = path.join(probeDir, "lock-owner-lock");
  const workerProbeLock = path.join(probeDir, "worker-lock");
  const workerProbeStarted = path.join(probeDir, "worker-started");
  const workerProbeRelease = path.join(probeDir, "worker-release");
  writeExecutable(
    path.join(probeDir, "ps"),
    [
      "#!/bin/sh",
      'if mkdir "$CODEX_TEST_PARENT_PROBE_LOCK" 2>/dev/null; then',
      '  printf \'started\\n\' > "$CODEX_TEST_PARENT_PROBE_STARTED"',
      '  while [ ! -e "$CODEX_TEST_PARENT_PROBE_RELEASE" ]; do sleep 0.01; done',
      'elif mkdir "$CODEX_TEST_LOCK_OWNER_PROBE_LOCK" 2>/dev/null; then',
      "  :",
      'elif mkdir "$CODEX_TEST_WORKER_PROBE_LOCK" 2>/dev/null; then',
      '  printf \'started\\n\' > "$CODEX_TEST_WORKER_PROBE_STARTED"',
      '  while [ ! -e "$CODEX_TEST_WORKER_PROBE_RELEASE" ]; do sleep 0.01; done',
      "fi",
      "printf 'Mon Jul 27 12:34:56 2026\\n'"
    ].join("\n") + "\n"
  );
  fs.writeFileSync(parentProbeRelease, "");

  const baseEnv = buildEnv(binDir);
  const env = {
    ...baseEnv,
    PATH: `${probeDir}:${baseEnv.PATH}`,
    CODEX_TEST_PARENT_PROBE_LOCK: parentProbeLock,
    CODEX_TEST_PARENT_PROBE_STARTED: parentProbeStarted,
    CODEX_TEST_PARENT_PROBE_RELEASE: parentProbeRelease,
    CODEX_TEST_LOCK_OWNER_PROBE_LOCK: lockOwnerProbeLock,
    CODEX_TEST_WORKER_PROBE_LOCK: workerProbeLock,
    CODEX_TEST_WORKER_PROBE_STARTED: workerProbeStarted,
    CODEX_TEST_WORKER_PROBE_RELEASE: workerProbeRelease
  };
  t.after(() => {
    if (!fs.existsSync(workerProbeRelease)) {
      fs.writeFileSync(workerProbeRelease, "");
    }
  });

  const launched = run("node", [SCRIPT, "adversarial-review", "--background", "--json"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.summary, "Adversarial Review working tree diff");

  // Commit while the worker is held. The pinned working-tree target is still
  // honored, but the content it names has moved into the branch diff.
  await waitFor(() => fs.existsSync(workerProbeStarted), { timeoutMs: 10000, intervalMs: 10 });
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "feature work"], { cwd: repo });
  fs.writeFileSync(workerProbeRelease, "");

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);

  // The whole point: Codex must never have been asked to review the empty
  // post-commit working tree. Without this the review reports a clean result
  // for a change it never saw.
  const stateFile = path.join(binDir, "fake-codex-state.json");
  const codexState = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
  assert.equal(codexState.lastTurnStart ?? null, null, codexState.lastTurnStart?.prompt);

  const job = JSON.parse(waitedStatus.stdout).job;
  assert.equal(job.status, "failed", waitedStatus.stdout);
  assert.match(job.errorMessage, /moved between enqueue and execution/);

  // A controller must be able to tell a moved-repository failure from a real
  // review failure without reading the message.
  assert.equal(job.failureClass, "state-drift");
  assert.equal(job.retryable, true);
});

test("a legacy background review without state identity still runs", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  const target = {
    mode: "working-tree",
    label: "working tree diff",
    explicit: false
  };
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "move pinned work"], { cwd: repo });

  const jobId = `review-legacy-${Date.now().toString(36)}`;
  const logFile = resolveJobLogFile(repo, jobId);
  ensureStateDir(repo);
  fs.writeFileSync(logFile, "", "utf8");
  const child = spawn(
    process.execPath,
    [SCRIPT, "job-worker", "--cwd", repo, "--job-id", jobId],
    { cwd: repo, env: buildEnv(binDir), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  const queuedJob = {
    id: jobId,
    kind: "adversarial-review",
    kindLabel: "adversarial-review",
    title: "Codex Adversarial Review",
    workspaceRoot: repo,
    jobClass: "review",
    summary: "Adversarial Review working tree diff",
    write: false,
    createdAt: new Date().toISOString(),
    status: "queued",
    phase: "queued",
    pid: child.pid,
    pidStartTime: null,
    logFile,
    request: {
      cwd: repo,
      target,
      model: "gpt-5.5",
      effort: null,
      effortOverride: false,
      focusText: "",
      reviewName: "Adversarial Review"
    }
  };
  writeJobFile(repo, jobId, queuedJob);
  upsertJob(repo, queuedJob);

  const result = await waitForChildExit(child, 15000);

  assert.equal(result.code, 0, result.stderr);
  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobId), "utf8"));
  assert.equal(storedJob.status, "completed");
  assert.ok(JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")).lastTurnStart);
});

test("review rejects --wait and --background together", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--wait", "--background"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose either --wait or --background\./);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: buildEnv(makeTempDir())
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex:status review-live`<br>`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  const otherPid = spawnDeadPid();
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            pid: otherPid,
            logFile: otherLog,
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find((job) => job.id === "review-other").status, "failed");
  assert.equal(state.jobs.find((job) => job.id === "review-other").reaped, true);
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            status: "running",
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: buildEnv(makeTempDir())
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("status --json reaps a dead running job and freezes its duration", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  ensureStateDir(workspace);

  const jobId = "task-dead";
  const logFile = resolveJobLogFile(workspace, jobId);
  const startedAt = "2020-01-01T00:00:00.000Z";
  const expectedCompletedAt = "2020-01-01T00:01:05.000Z";
  fs.writeFileSync(logFile, `[${startedAt}] Worker started.\n`, "utf8");
  fs.utimesSync(logFile, new Date(expectedCompletedAt), new Date(expectedCompletedAt));
  const logMtime = fs.statSync(logFile).mtime.toISOString();
  const deadPid = spawnDeadPid();
  const storedRecord = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: deadPid,
    startedAt,
    logFile,
    threadId: "thr_dead",
    request: { prompt: "finish the task" },
    result: { partial: true }
  };
  writeJobFile(workspace, jobId, storedRecord);
  upsertJob(workspace, {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: deadPid,
    startedAt,
    logFile
  });

  const first = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env: buildEnv(makeTempDir())
  });

  assert.equal(first.status, 0, first.stderr);
  const firstPayload = JSON.parse(first.stdout);
  assert.deepEqual(firstPayload.running, []);
  assert.equal(firstPayload.latestFinished.status, "failed");
  assert.equal(firstPayload.latestFinished.reaped, true);
  assert.equal(firstPayload.latestFinished.pid, null);
  assert.equal(firstPayload.latestFinished.completedAt, logMtime);
  assert.equal(firstPayload.latestFinished.elapsed, "1m 5s");
  assert.equal(firstPayload.latestFinished.duration, "1m 5s");
  assert.equal(
    firstPayload.latestFinished.errorMessage,
    `Worker process ${deadPid} is no longer running; the job ended without recording a result.`
  );

  const second = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env: buildEnv(makeTempDir())
  });

  assert.equal(second.status, 0, second.stderr);
  const secondPayload = JSON.parse(second.stdout);
  assert.equal(secondPayload.latestFinished.elapsed, firstPayload.latestFinished.elapsed);
  assert.equal(secondPayload.latestFinished.duration, firstPayload.latestFinished.duration);

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(persisted.threadId, "thr_dead");
  assert.deepEqual(persisted.request, { prompt: "finish the task" });
  assert.deepEqual(persisted.result, { partial: true });
  const log = fs.readFileSync(logFile, "utf8");
  assert.match(log, new RegExp(`Job reaped: worker process ${deadPid} is gone; marking failed\\.`));
  assert.equal(log.match(/Job reaped:/g)?.length, 1);
});

test("status --json leaves live and pid-less running jobs active", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  ensureStateDir(workspace);

  upsertJob(workspace, {
    id: "task-live-pid",
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: process.pid,
    startedAt: new Date(Date.now() - 1000).toISOString()
  });
  upsertJob(workspace, {
    id: "task-no-pid",
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: null,
    startedAt: new Date(Date.now() - 1000).toISOString()
  });

  const result = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env: buildEnv(makeTempDir())
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const liveJob = payload.running.find((job) => job.id === "task-live-pid");
  const pidlessJob = payload.running.find((job) => job.id === "task-no-pid");
  assert.equal(liveJob.status, "running");
  assert.equal(liveJob.pid, process.pid);
  assert.equal(liveJob.reaped, undefined);
  assert.equal(pidlessJob.status, "running");
  assert.equal(pidlessJob.pid, null);
  assert.equal(pidlessJob.reaped, undefined);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: buildEnv(makeTempDir())
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nCodex session ID: thr_current\nResume in Codex: codex resume thr_current\n"
  );
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const processBinDir = makeTempDir();
  const processEnv = {
    ...process.env,
    PATH: `${processBinDir}:${process.env.PATH ?? ""}`
  };
  writeExecutable(
    path.join(processBinDir, "ps"),
    "#!/bin/sh\nprintf 'Mon Jul 27 12:34:56 2026\\n'\n"
  );
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  const pidStartTime = await waitFor(() => getProcessStartTime(sleeper.pid, { env: processEnv }));

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            pidStartTime,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace,
    env: processEnv
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.workerSignalAttempted, true);
  assert.equal(cancelPayload.workerSignalled, true);

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel marks a legacy job cancelled without signalling its worker", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobId = "task-legacy-worker";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    logFile
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: workspace
  });

  assert.equal(cancel.status, 0, cancel.stderr);
  const cancelPayload = JSON.parse(cancel.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.workerSignalAttempted, false);
  assert.equal(cancelPayload.workerSignalled, false);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  assert.match(fs.readFileSync(logFile, "utf8"), /no verified worker/i);
});

test("cancel reaps an explicit dead-PID job without signalling it", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  ensureStateDir(workspace);

  const jobId = "task-dead-explicit-cancel";
  const deadPid = spawnDeadPid();
  const logFile = resolveJobLogFile(workspace, jobId);
  const killLog = path.join(makeTempDir(), "kill-signals.log");
  const processProbeHook = path.join(makeTempDir(), "process-probe.cjs");
  fs.writeFileSync(killLog, "", "utf8");
  fs.writeFileSync(
    processProbeHook,
    `const originalKill = process.kill;\n` +
      `process.kill = function (pid, signal) {\n` +
      `  if (pid === ${deadPid} && signal !== 0) require("node:fs").appendFileSync(${JSON.stringify(killLog)}, String(signal) + "\\n");\n` +
      `  return originalKill.call(process, pid, signal);\n` +
      `};\n`,
    "utf8"
  );
  fs.writeFileSync(logFile, "", "utf8");
  writeJobFile(workspace, jobId, {
    id: jobId,
    status: "running",
    title: "Dead Codex Task",
    jobClass: "task",
    pid: deadPid,
    logFile
  });
  upsertJob(workspace, {
    id: jobId,
    status: "running",
    title: "Dead Codex Task",
    jobClass: "task",
    pid: deadPid,
    logFile
  });

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: workspace,
    env: {
      ...buildEnv(binDir),
      NODE_OPTIONS: `--require=${processProbeHook}`
    }
  });

  assert.equal(cancel.status, 0, cancel.stderr);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.jobId, jobId);
  assert.equal(payload.status, "failed");
  assert.equal(payload.title, "Dead Codex Task");
  assert.equal(payload.reaped, true);
  assert.equal(payload.turnInterruptAttempted, false);
  assert.equal(payload.turnInterrupted, false);
  assert.equal(payload.workerSignalAttempted, false);
  assert.equal(payload.workerSignalled, false);
  assert.equal(fs.readFileSync(killLog, "utf8"), "");

  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.reaped, true);
  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "state.json"), "utf8"));
  assert.equal(state.jobs.find((job) => job.id === jobId).status, "failed");
  assert.equal(state.jobs.find((job) => job.id === jobId).reaped, true);
});

test("cancel reaps an explicit reused-PID job without signalling it", async (t) => {
  const workspace = makeTempDir();
  const processBinDir = makeTempDir();
  const processEnv = {
    ...process.env,
    PATH: `${processBinDir}:${process.env.PATH ?? ""}`
  };
  writeExecutable(
    path.join(processBinDir, "ps"),
    "#!/bin/sh\nprintf 'Mon Jul 28 12:34:56 2026\\n'\n"
  );
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobId = "task-replaced-worker";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    pidStartTime: "Mon Jul 27 12:34:55 2026",
    logFile
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: workspace,
    env: processEnv
  });

  assert.equal(cancel.status, 0, cancel.stderr);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.jobId, jobId);
  assert.equal(payload.status, "failed");
  assert.equal(payload.title, "Codex Task");
  assert.equal(payload.reaped, true);
  assert.equal(payload.turnInterruptAttempted, false);
  assert.equal(payload.turnInterrupted, false);
  assert.equal(payload.workerSignalAttempted, false);
  assert.equal(payload.workerSignalled, false);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].reaped, true);
  const persisted = JSON.parse(fs.readFileSync(resolveJobFile(workspace, jobId), "utf8"));
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.reaped, true);
});

test("cancel marks an unverifiable worker cancelled without signalling it", async (t) => {
  const workspace = makeTempDir();
  const processBinDir = makeTempDir();
  const processEnv = {
    ...process.env,
    PATH: `${processBinDir}:${process.env.PATH ?? ""}`
  };
  writeExecutable(
    path.join(processBinDir, "ps"),
    "#!/bin/sh\nprintf 'ambiguous-start\\nsecond-start\\n'\n"
  );
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobId = "task-unverifiable-worker";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    pidStartTime: "worker-start",
    logFile
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: workspace,
    env: processEnv
  });

  assert.equal(cancel.status, 0, cancel.stderr);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.workerSignalAttempted, false);
  assert.equal(payload.workerSignalled, false);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
});

test("cancelled unverifiable background tasks stay cancelled after natural completion", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const processBinDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  writeExecutable(
    path.join(processBinDir, "ps"),
    "#!/bin/sh\nprintf 'ambiguous-start\\nsecond-start\\n'\n"
  );
  const baseEnv = buildEnv(binDir);
  const env = {
    ...baseEnv,
    PATH: `${processBinDir}:${baseEnv.PATH}`
  };
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "finish this task naturally"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  const stateFile = path.join(resolveStateDir(repo), "state.json");
  const runningJob = await waitFor(
    () => {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        const job = state.jobs?.find((candidate) => candidate.id === jobId);
        return job?.status === "running" ? job : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 10000, intervalMs: 25 }
  );
  assert.equal(runningJob.pidStartTime, null);

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancel.status, 0, cancel.stderr);
  const cancelPayload = JSON.parse(cancel.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.workerSignalAttempted, false);
  assert.equal(cancelPayload.workerSignalled, false);
  assert.doesNotThrow(() => process.kill(runningJob.pid, 0));
  await waitForProcessExit(runningJob.pid);

  const finishedJob = await waitFor(
    () => {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        const job = state.jobs?.find((candidate) => candidate.id === jobId);
        return job?.status === "cancelled" ? job : null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 10000, intervalMs: 25 }
  );
  assert.equal(finishedJob.status, "cancelled");
  assert.equal(finishedJob.phase, "cancelled");
  assert.equal(finishedJob.pid, null);

  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobId), "utf8"));
  assert.equal(storedJob.status, "cancelled");
  assert.equal(storedJob.phase, "cancelled");
  assert.equal(storedJob.pid, null);
});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Codex jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel skips turn interrupt when the recorded pid dies after resolution", () => {
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  ensureStateDir(workspace);

  const jobId = "task-no-worker";
  const workerPid = 2_147_483_647;
  const processProbeHook = path.join(makeTempDir(), "process-probe.cjs");
  fs.writeFileSync(
    processProbeHook,
    `const originalKill = process.kill;\n` +
      `let probes = 0;\n` +
      `process.kill = function (pid, signal) {\n` +
      `  if (pid === ${workerPid} && signal === 0) {\n` +
      `    probes += 1;\n` +
      `    if (probes === 1) return true;\n` +
      `    const error = new Error("kill ESRCH");\n` +
      `    error.code = "ESRCH";\n` +
      `    throw error;\n` +
      `  }\n` +
      `  return originalKill.call(process, pid, signal);\n` +
      `};\n`,
    "utf8"
  );
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: workerPid,
    logFile,
    threadId: "thr_gone",
    turnId: "turn_gone"
  };
  writeJobFile(workspace, jobId, job);
  upsertJob(workspace, job);

  const cancel = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: workspace,
    env: {
      ...buildEnv(binDir),
      NODE_OPTIONS: `--require=${processProbeHook}`
    }
  });

  assert.equal(cancel.status, 0, cancel.stderr);
  const payload = JSON.parse(cancel.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.turnInterruptAttempted, false);
  assert.equal(payload.turnInterrupted, false);
  assert.equal(payload.turnInterruptDetail, "worker process is gone");
});

test("cancel sends turn interrupt to the shared app-server before killing a brokered task", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("cancel completes and persists cancellation when turn interrupt never replies", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  ensureStateDir(repo);

  const endpoint = await startTestBroker(t, (socket, message) => {
    if (message.method === "initialize") {
      socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
    }
  });
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobId = "task-interrupt-timeout";
  const logFile = resolveJobLogFile(repo, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    logFile,
    threadId: "thr_timeout",
    turnId: "turn_timeout"
  };
  writeJobFile(repo, jobId, job);
  upsertJob(repo, job);

  const startedAt = Date.now();
  const child = spawn(process.execPath, [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result = await waitForChildExit(child, 20000);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.ok(Date.now() - startedAt < 20000);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.turnInterruptAttempted, true);
  assert.equal(payload.turnInterrupted, false);
  assert.match(payload.turnInterruptDetail, /timed out after \d+ms/);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobId), "utf8"));
  assert.equal(stored.status, "cancelled");
});

test("cancel stays within one interrupt budget when the broker never releases the socket", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  ensureStateDir(repo);

  // A wedged broker answers initialize, never answers turn/interrupt, and never acts on the FIN
  // the client sends while closing. The interrupt deadline and the cleanup deadline must not
  // stack: cancel has to stay inside roughly one interrupt budget, not two.
  const endpoint = await startTestBroker(
    t,
    (socket, message) => {
      if (message.method === "initialize") {
        socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
    },
    { allowHalfOpen: true }
  );
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobId = "task-halfopen-interrupt-timeout";
  const logFile = resolveJobLogFile(repo, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    logFile,
    threadId: "thr_halfopen_timeout",
    turnId: "turn_halfopen_timeout"
  };
  writeJobFile(repo, jobId, job);
  upsertJob(repo, job);

  const startedAt = Date.now();
  const child = spawn(process.execPath, [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result = await waitForChildExit(child, 20000);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.ok(elapsedMs < 15000, `cancel must not stack two interrupt budgets, elapsed ${elapsedMs}ms`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.turnInterruptAttempted, true);
  assert.equal(payload.turnInterrupted, false);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobId), "utf8"));
  assert.equal(stored.status, "cancelled");
});

test("cancel completes and persists cancellation when app-server initialize never replies", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  ensureStateDir(repo);

  const endpoint = await startTestBroker(t, () => {});
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobId = "task-initialize-timeout";
  const logFile = resolveJobLogFile(repo, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    logFile,
    threadId: "thr_initialize_timeout",
    turnId: "turn_initialize_timeout"
  };
  writeJobFile(repo, jobId, job);
  upsertJob(repo, job);

  const startedAt = Date.now();
  const child = spawn(process.execPath, [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result = await waitForChildExit(child, 20000);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.ok(Date.now() - startedAt < 20000);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.turnInterruptAttempted, true);
  assert.equal(payload.turnInterrupted, false);
  assert.match(payload.turnInterruptDetail, /initialize timed out after \d+ms/);
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobId), "utf8"));
  assert.equal(stored.status, "cancelled");
});

test("cancel shares one timeout across slow initialize and turn interrupt", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  ensureStateDir(repo);

  let interruptSeen = false;
  const endpoint = await startTestBroker(t, (socket, message) => {
    if (message.method === "initialize") {
      setTimeout(() => {
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        }
      }, 7500);
    } else if (message.method === "turn/interrupt") {
      interruptSeen = true;
    }
  });
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const jobId = "task-shared-interrupt-timeout";
  const logFile = resolveJobLogFile(repo, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  const job = {
    id: jobId,
    status: "running",
    title: "Codex Task",
    jobClass: "task",
    pid: sleeper.pid,
    logFile,
    threadId: "thr_shared_timeout",
    turnId: "turn_shared_timeout"
  };
  writeJobFile(repo, jobId, job);
  upsertJob(repo, job);

  const startedAt = Date.now();
  const child = spawn(process.execPath, [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result = await waitForChildExit(child, 15000);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.ok(Date.now() - startedAt < 15000);
  assert.equal(interruptSeen, true);
  assert.equal(JSON.parse(result.stdout).status, "cancelled");
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobId), "utf8"));
  assert.equal(stored.status, "cancelled");
});

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const processBinDir = makeTempDir();
  writeExecutable(
    path.join(processBinDir, "ps"),
    "#!/bin/sh\nprintf 'Mon Jul 27 12:34:56 2026\\n'\n"
  );
  const processEnv = {
    ...process.env,
    PATH: `${processBinDir}:${process.env.PATH ?? ""}`
  };

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  const pidStartTime = await waitFor(() => getProcessStartTime(sleeper.pid, { env: processEnv }));
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            pidStartTime,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...processEnv,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [path.basename(otherJobFile), path.basename(otherSessionLog)].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["review-other"]);
  const otherJob = state.jobs[0];
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("session end does not signal a worker with an unverified identity", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  ensureStateDir(repo);

  const processBinDir = makeTempDir();
  writeExecutable(
    path.join(processBinDir, "ps"),
    "#!/bin/sh\nprintf 'Mon Jul 28 12:34:56 2026\\n'\n"
  );
  const env = {
    ...process.env,
    PATH: `${processBinDir}:${process.env.PATH ?? ""}`
  };
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(resolveStateDir(repo), "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-unverified-worker",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-unverified",
            pid: sleeper.pid,
            pidStartTime: "1970-01-01T00:00:00.000Z",
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-unverified",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(
    waitFor(
      () => {
        try {
          process.kill(sleeper.pid, 0);
          return false;
        } catch (error) {
          if (error?.code === "ESRCH") {
            return true;
          }
          throw error;
        }
      },
      { timeoutMs: 500, intervalMs: 25 }
    ),
    /Timed out waiting for condition/
  );
  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.deepEqual(state.jobs, []);
});

// A broker record read off disk can be arbitrarily old, so its pid may have been recycled by the
// OS. `terminateProcessTree` signals a whole process group, so a mis-targeted signal takes out an
// unrelated group. Both shapes below assert SessionEnd refuses to signal an unverifiable pid.
function startBrokerRecordSleeper(t, repo) {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGKILL");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Ignore missing process.
      }
    }
  });

  return sleeper;
}

function writeStaleBrokerRecord(repo, record) {
  const sessionDir = makeTempDir();
  saveBrokerSession(repo, {
    endpoint: `unix:${path.join(sessionDir, "broker.sock")}`,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    ...record
  });
}

async function assertPidSurvives(pid) {
  await assert.rejects(
    waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error?.code === "ESRCH") {
            return true;
          }
          throw error;
        }
      },
      { timeoutMs: 500, intervalMs: 25 }
    ),
    /Timed out waiting for condition/
  );
}

test("session end does not signal a broker pid whose recorded start time does not match", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  ensureStateDir(repo);

  const processBinDir = makeTempDir();
  writeExecutable(
    path.join(processBinDir, "ps"),
    "#!/bin/sh\nprintf 'Mon Jul 28 12:34:56 2026\\n'\n"
  );
  const env = {
    ...process.env,
    PATH: `${processBinDir}:${process.env.PATH ?? ""}`
  };

  const sleeper = startBrokerRecordSleeper(t, repo);
  writeStaleBrokerRecord(repo, {
    pid: sleeper.pid,
    pidStartTime: "1970-01-01T00:00:00.000Z"
  });

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-stale-broker",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  await assertPidSurvives(sleeper.pid);
});

// Records written by older plugin versions carry no `pidStartTime`. Absent proof of identity the
// pid must not be signalled at all — the leak is bounded by the broker's idle self-exit, a
// mis-targeted process-group SIGTERM is not.
test("session end does not signal a broker record that carries no recorded start time", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  ensureStateDir(repo);

  const processBinDir = makeTempDir();
  writeExecutable(
    path.join(processBinDir, "ps"),
    "#!/bin/sh\nprintf 'Mon Jul 28 12:34:56 2026\\n'\n"
  );
  const env = {
    ...process.env,
    PATH: `${processBinDir}:${process.env.PATH ?? ""}`
  };

  const sleeper = startBrokerRecordSleeper(t, repo);
  writeStaleBrokerRecord(repo, { pid: sleeper.pid });

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-legacy-broker",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  await assertPidSurvives(sleeper.pid);
});

test("session end signals a broker pid whose recorded start time still matches", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  ensureStateDir(repo);

  const sleeper = startBrokerRecordSleeper(t, repo);
  const pidStartTime = await waitFor(() => getProcessStartTime(sleeper.pid));
  writeStaleBrokerRecord(repo, { pid: sleeper.pid, pidStartTime });

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: process.env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-live-broker",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  await waitForProcessExit(sleeper.pid);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still running/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Codex is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands lazily start and reuse one shared app-server after first use", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup reuses an existing shared app-server without starting another one", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  if (!loadBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});

test("shared broker interrupts an orphaned turn when its owning client disconnects mid-turn", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "idle-hung-turn");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const session = await ensureBrokerSession(repo, { env });
  assert.ok(session?.endpoint, "broker session should start");

  t.after(async () => {
    await sendBrokerShutdown(session.endpoint).catch(() => {});
  });

  const target = parseBrokerEndpoint(session.endpoint);
  const socket = net.createConnection({ path: target.path });
  socket.setEncoding("utf8");

  const pending = new Map();
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  function request(id, method, params) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  await request(1, "initialize", { capabilities: {} });
  socket.write(`${JSON.stringify({ method: "initialized" })}\n`);

  const threadResponse = await request(2, "thread/start", { cwd: repo });
  const threadId = threadResponse.result.thread.id;
  assert.ok(threadId);

  const turnResponse = await request(3, "turn/start", {
    threadId,
    input: [{ type: "text", text: "work forever" }]
  });
  const turnId = turnResponse.result.turn.id;
  assert.ok(turnId);

  // Simulate the foreground `--wait` client being SIGKILLed mid-turn: the OS drops the broker
  // socket while the turn is still running. The watchdog that lived in the killed client is gone,
  // so the broker must abort the now-unsupervised turn itself.
  socket.destroy();

  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return state.lastInterrupt ?? null;
  }, { timeoutMs: 5000 });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, { threadId, turnId });
});

test("shared broker interrupts a turn orphaned by a disconnect during the turn/start round-trip", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "delayed-turn-start");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const session = await ensureBrokerSession(repo, { env });
  assert.ok(session?.endpoint, "broker session should start");

  t.after(async () => {
    await sendBrokerShutdown(session.endpoint).catch(() => {});
  });

  const target = parseBrokerEndpoint(session.endpoint);
  const socket = net.createConnection({ path: target.path });
  socket.setEncoding("utf8");

  const pending = new Map();
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  function request(id, method, params) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  await request(1, "initialize", { capabilities: {} });
  socket.write(`${JSON.stringify({ method: "initialized" })}\n`);

  const threadResponse = await request(2, "thread/start", { cwd: repo });
  const threadId = threadResponse.result.thread.id;
  assert.ok(threadId);

  // Fire turn/start but do NOT wait for the (deliberately delayed) response, then drop the client
  // mid-round-trip — before the broker has recorded stream ownership. The broker must still abort
  // the turn once the response resolves, rather than adopting the dead socket as owner.
  socket.write(`${JSON.stringify({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: "work forever" }] } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.destroy();

  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return state.lastInterrupt ?? null;
  }, { timeoutMs: 5000 });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastInterrupt.threadId, threadId);
  assert.equal(fakeState.lastInterrupt.turnId, fakeState.lastTurnStart.turnId);
});

test("shared broker stays busy while an orphaned turn is being interrupted, blocking overlap", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "idle-hung-slow-interrupt");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const session = await ensureBrokerSession(repo, { env });
  assert.ok(session?.endpoint, "broker session should start");

  const target = parseBrokerEndpoint(session.endpoint);
  const opened = [];
  t.after(async () => {
    for (const s of opened) {
      s.destroy();
    }
    await sendBrokerShutdown(session.endpoint).catch(() => {});
  });

  function openClient() {
    const socket = net.createConnection({ path: target.path });
    socket.setEncoding("utf8");
    opened.push(socket);
    const pending = new Map();
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
    });
    const ready = new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const request = (id, method, params) =>
      new Promise((resolve) => {
        pending.set(id, resolve);
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    return { socket, ready, request };
  }

  const a = openClient();
  await a.ready;
  await a.request(1, "initialize", { capabilities: {} });
  a.socket.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const threadResponse = await a.request(2, "thread/start", { cwd: repo });
  const threadId = threadResponse.result.thread.id;
  await a.request(3, "turn/start", { threadId, input: [{ type: "text", text: "work forever" }] });

  // Client A drops mid-turn. The broker interrupts the orphan, but the fake delays the interrupt
  // response, so the abort is still in flight (single-flight slot reserved) for ~600ms.
  a.socket.destroy();
  await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return state.lastInterrupt ?? null;
  }, { timeoutMs: 5000 });

  // A second client must NOT be able to start an overlapping turn during the abort window.
  const b = openClient();
  await b.ready;
  await b.request(1, "initialize", { capabilities: {} });
  b.socket.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const busy = await b.request(2, "turn/start", { threadId, input: [{ type: "text", text: "overlap" }] });
  assert.ok(busy.error, "second client should be rejected while the orphan is being interrupted");
  assert.match(busy.error.message, /busy/i);

  // Once the interrupt settles, the broker recovers and accepts a fresh turn.
  const recovered = await waitFor(async () => {
    const resp = await b.request(3, "turn/start", { threadId, input: [{ type: "text", text: "after" }] });
    return resp.result ? resp : null;
  }, { timeoutMs: 5000, intervalMs: 100 });
  assert.ok(recovered.result.turn?.id, "broker should accept a new turn after the abort settles");
});

test("shared broker self-exits after its idle timeout with no clients", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = { ...buildEnv(binDir), CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS: "600" };
  const session = await ensureBrokerSession(repo, { env });
  assert.ok(session?.pid, "broker session should start");

  // No client connects; the broker should self-exit once the idle window elapses.
  await waitFor(() => {
    try {
      process.kill(session.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }, { timeoutMs: 5000, intervalMs: 100 });
});

test("a task aborted by the idle watchdog does not report its preamble as the final output (#88)", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "idle-hung-turn-after-preamble");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_TURN_STALL_TIMEOUT_MS: "1500",
    CODEX_TOOL_STALL_TIMEOUT_MS: "300"
  };
  const launched = run("node", [SCRIPT, "task", "--write", "--background", "--json", "apply the three edits"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "250", "--json"],
    { cwd: repo, env }
  );
  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.status, "failed");

  const stored = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  const storedPayload = JSON.parse(stored.stdout);
  const result = storedPayload.storedJob.result;

  // The preamble is not a report: rawOutput is the field every downstream consumer parses.
  assert.equal(result.rawOutput, "", "rawOutput must be empty when the turn never produced a final message");
  assert.match(result.partialOutput, /applying only the requested edits/);
  assert.match(result.failureMessage, /Codex turn stalled \(idle\)/);
  // The edits already landed, so the payload has to keep saying so.
  assert.ok(result.touchedFiles.some((file) => file.endsWith("README.md")), JSON.stringify(result.touchedFiles));

  assert.match(storedPayload.storedJob.rendered, /Codex turn stalled \(idle\)/);
  assert.match(storedPayload.storedJob.rendered, /README\.md/);
  assert.doesNotMatch(storedPayload.job.summary ?? "", /applying only the requested edits/);
});
