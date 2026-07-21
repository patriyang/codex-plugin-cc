#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

// Upper bound on how long the broker keeps its single-flight slot reserved while interrupting an
// orphaned turn. Normally the interrupt settles in milliseconds; this only guards against an
// interrupt that never gets a response, so the broker can never wedge itself permanently busy.
const ABORT_INTERRUPT_TIMEOUT_MS = 10_000;

// How long a broker may sit idle (no connected clients, nothing in flight) before it self-exits.
// Brokers are detached and normally reaped by the SessionEnd hook; this self-timeout keeps a broker
// whose owning session died without a clean SessionEnd from lingering forever. A value of 0 disables
// it (never self-exit).
const DEFAULT_BROKER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function resolveBrokerIdleTimeoutMs(env = process.env) {
  const raw = env?.CODEX_COMPANION_BROKER_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_BROKER_IDLE_TIMEOUT_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BROKER_IDLE_TIMEOUT_MS;
}

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let activeStreamTurnId = null;
  // Set while an orphaned turn is being interrupted. Keeps the broker reporting busy so no other
  // client can start an overlapping turn (or receive the orphan's trailing notifications) until the
  // interrupt settles.
  let abortingTurnId = null;
  const sockets = new Set();

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
      activeStreamTurnId = null;
    }
  }

  function abortStreamedTurn(threadIds, turnId) {
    // The client that owned this streamed turn dropped before it completed. The turn is still
    // running on the shared app-server, unsupervised (any client-side watchdog died with the
    // client), so interrupt it here — the broker outlives any single client. Reserve the
    // single-flight slot (abortingTurnId) until the interrupt settles so no other client can start
    // an overlapping turn or be handed this turn's trailing notifications mid-teardown.
    if (!turnId || !threadIds || threadIds.size === 0) {
      return;
    }
    abortingTurnId = turnId;
    const interrupts = [...threadIds].map((threadId) =>
      appClient.request("turn/interrupt", { threadId, turnId }).catch(() => {})
    );
    const bounded = new Promise((resolve) => {
      const timer = setTimeout(resolve, ABORT_INTERRUPT_TIMEOUT_MS);
      timer.unref?.();
    });
    Promise.race([Promise.all(interrupts), bounded]).finally(() => {
      if (abortingTurnId === turnId) {
        abortingTurnId = null;
      }
    });
  }

  function handleSocketGone(socket) {
    const threadIds = activeStreamSocket === socket ? activeStreamThreadIds : null;
    const turnId = activeStreamSocket === socket ? activeStreamTurnId : null;
    sockets.delete(socket);
    clearSocketOwnership(socket);
    abortStreamedTurn(threadIds, turnId);
    // A client just left — restart the idle countdown so a broker with no remaining clients exits.
    bumpIdleTimer();
  }

  const idleTimeoutMs = resolveBrokerIdleTimeoutMs(process.env);
  let idleTimer = null;

  function bumpIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!(idleTimeoutMs > 0 && Number.isFinite(idleTimeoutMs))) {
      return;
    }
    idleTimer = setTimeout(onIdleTimeout, idleTimeoutMs);
    idleTimer.unref?.();
  }

  async function onIdleTimeout() {
    idleTimer = null;
    // Never exit mid-work: a live client, an in-flight request/stream, or an in-progress orphan
    // abort all count as busy — re-arm instead.
    if (sockets.size > 0 || activeRequestSocket || activeStreamSocket || abortingTurnId) {
      bumpIdleTimer();
      return;
    }
    await shutdown(server);
    process.exit(0);
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        activeStreamTurnId = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    bumpIdleTimer();
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      bumpIdleTimer();
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        if (abortingTurnId) {
          // An orphaned turn is still being interrupted; keep the single-flight slot reserved so a
          // new client can't overlap it or inherit its trailing notifications.
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            const threadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            const turnId = result?.turn?.id ?? null;
            if (socket.destroyed || !sockets.has(socket)) {
              // The client disconnected during the app-server round-trip, before we could record
              // stream ownership — so the close handler already ran and saw no active stream to
              // interrupt. Abort the just-started turn here instead of adopting a dead owner, which
              // would leave the turn unsupervised and wedge the broker as permanently busy.
              abortStreamedTurn(threadIds, turnId);
            } else {
              activeStreamSocket = socket;
              activeStreamThreadIds = threadIds;
              activeStreamTurnId = turnId;
            }
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      handleSocketGone(socket);
    });

    socket.on("error", () => {
      handleSocketGone(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
  bumpIdleTimer();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
