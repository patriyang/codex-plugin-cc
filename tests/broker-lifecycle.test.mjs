import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  clearBrokerSession,
  loadBrokerSession,
  saveBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

delete process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;
process.env.CLAUDE_PLUGIN_DATA = makeTempDir();

function brokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), "broker.json");
}

test("clearBrokerSession does not remove a newer broker session", () => {
  const workspace = makeTempDir();
  const sessionA = { endpoint: "unix:/tmp/broker-a.sock" };
  const sessionB = { endpoint: "unix:/tmp/broker-b.sock" };

  saveBrokerSession(workspace, sessionA);
  const loadedByA = loadBrokerSession(workspace);
  saveBrokerSession(workspace, sessionB);

  const removed = clearBrokerSession(workspace, loadedByA);

  assert.equal(removed, false);
  assert.deepEqual(loadBrokerSession(workspace), sessionB);
});

test("clearBrokerSession removes a matching broker session", () => {
  const workspace = makeTempDir();
  const session = { endpoint: "unix:/tmp/matching-broker.sock" };
  saveBrokerSession(workspace, session);

  assert.equal(clearBrokerSession(workspace, session), true);
  assert.equal(loadBrokerSession(workspace), null);
});

test("clearBrokerSession removes an unparseable broker record", () => {
  const workspace = makeTempDir();
  saveBrokerSession(workspace, { endpoint: "unix:/tmp/unparseable-broker.sock" });
  fs.writeFileSync(brokerStateFile(workspace), "not json\n", "utf8");

  assert.equal(clearBrokerSession(workspace), true);
  assert.equal(fs.existsSync(brokerStateFile(workspace)), false);
});

test("clearBrokerSession leaves a foreign record alone without an expected session", () => {
  const workspace = makeTempDir();
  const session = { endpoint: "unix:/tmp/foreign-broker.sock" };
  saveBrokerSession(workspace, session);

  assert.equal(clearBrokerSession(workspace), false);
  assert.deepEqual(loadBrokerSession(workspace), session);
});

test("saveBrokerSession and clearBrokerSession serialize on the broker lock", () => {
  const workspace = makeTempDir();
  const lockFile = path.join(resolveStateDir(workspace), "broker.lock");
  const pidStartTime = "live-start";
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    `${JSON.stringify({ token: "live-owner", pid: process.pid, pidStartTime })}\n`,
    "utf8"
  );
  const lockOptions = {
    timeoutMs: 25,
    isProcessAlive: () => true,
    getProcessStartTime: () => pidStartTime
  };

  assert.throws(
    () => saveBrokerSession(workspace, { endpoint: "unix:/tmp/save-timeout.sock" }, lockOptions),
    /Timed out acquiring persistence lock/
  );
  assert.throws(
    () => clearBrokerSession(workspace, { endpoint: "unix:/tmp/clear-timeout.sock" }, lockOptions),
    /Timed out acquiring persistence lock/
  );
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, "live-owner");
});
