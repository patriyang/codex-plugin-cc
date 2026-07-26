import test from "node:test";
import assert from "node:assert/strict";

import { isProcessAlive, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

function findDeadPid() {
  for (let pid = 1_000_000; ; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return pid;
      }
    }
  }
}

test("isProcessAlive reports the current process as alive", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive reports a dead process as not alive", () => {
  assert.equal(isProcessAlive(findDeadPid()), false);
});

test("isProcessAlive rejects non-finite and non-positive pids", () => {
  const options = { killImpl() {} };

  for (const pid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
    assert.equal(isProcessAlive(pid, options), false);
  }
});

test("isProcessAlive treats a permission error as evidence the process exists", () => {
  const error = Object.assign(new Error("not permitted"), { code: "EPERM" });
  assert.equal(isProcessAlive(1234, {
    killImpl() {
      throw error;
    }
  }), true);
});

test("isProcessAlive fails open on an unknown error", () => {
  const error = Object.assign(new Error("ambiguous failure"), { code: "EUNKNOWN" });
  assert.equal(isProcessAlive(1234, {
    killImpl() {
      throw error;
    }
  }), true);
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
