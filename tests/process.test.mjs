import test from "node:test";
import assert from "node:assert/strict";

import {
  getProcessStartTime,
  isProcessAlive,
  terminateProcessTree
} from "../plugins/codex/scripts/lib/process.mjs";
import { spawnDeadPid } from "./helpers.mjs";

test("isProcessAlive reports the current process as alive", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive reports a dead process as not alive", () => {
  assert.equal(isProcessAlive(spawnDeadPid()), false);
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

test("getProcessStartTime normalizes a POSIX process start time", () => {
  let captured = null;
  const startTime = getProcessStartTime(1234, {
    platform: "darwin",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "  Mon Jul 27 12:34:56 2026  \n",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(startTime, "Mon Jul 27 12:34:56 2026");
  assert.deepEqual(captured, {
    command: "ps",
    args: ["-o", "lstart=", "-p", "1234"]
  });
});

test("getProcessStartTime returns unavailable for failed or ambiguous lookups", () => {
  assert.equal(
    getProcessStartTime(1234, {
      platform: "linux",
      runCommandImpl() {
        return { status: 1, stdout: "", stderr: "no such process", error: null };
      }
    }),
    null
  );
  assert.equal(
    getProcessStartTime(1234, {
      platform: "linux",
      runCommandImpl() {
        throw new Error("ps unavailable");
      }
    }),
    null
  );
  assert.equal(
    getProcessStartTime(1234, {
      platform: "linux",
      runCommandImpl() {
        return { status: 0, stdout: "first\nsecond\n", stderr: "", error: null };
      }
    }),
    null
  );
  assert.equal(getProcessStartTime(0), null);
});

test("getProcessStartTime normalizes a Windows process start time", () => {
  let captured = null;
  const startTime = getProcessStartTime(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        status: 0,
        stdout: "  2026-07-27T12:34:56.0000000Z\r\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(startTime, "2026-07-27T12:34:56.0000000Z");
  assert.equal(captured.command, "powershell.exe");
  assert.deepEqual(captured.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
  assert.match(captured.args[3], /Command/);
  assert.match(captured.args[4], /ProcessId = 1234/);
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
