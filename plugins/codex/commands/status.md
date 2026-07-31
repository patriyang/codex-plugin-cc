---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

## Waiting on a job

To block until a specific job finishes, pass its ID with `--wait`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status <job-id> --wait --json [--timeout-ms <ms>]
```

- It returns as soon as that job reaches a terminal state, and it re-reads the job record each poll, so a job whose process died is reaped and reported rather than blocking for the full timeout. (A job that never got a PID — a failed spawn — is not reapable and will block until the timeout.)
- `--wait` requires a job ID. Without one it errors out rather than waiting on the whole table.
- The default timeout matches `DEFAULT_STATUS_WAIT_TIMEOUT_MS` in `codex-companion.mjs`. On timeout the command still exits 0, and the only signal is `waitTimedOut: true` in the payload — which is why the invocation above passes `--json`. The plain-text renderer drops that field. On a timeout, re-arm the same wait; do not report the job as stuck or abandoned.
- Never hand-roll a poll loop that greps the bare `status` table. A stale record from a dead process keeps a generic matcher spinning forever, and the status vocabulary is `queued` / `running` / `completed` / `failed` / `cancelled` (plus `stalled` in the renderer) — a loop watching for `succeeded` waits on a string this runtime never emits. The job-scoped `--wait` is the only form that terminates reliably.
- Only `task --background` mints a job ID. A review detached with `Bash(run_in_background: true)` is a plain shell with no job record, so read it back with `BashOutput` instead.
- Claude cannot invoke this command (`disable-model-invocation: true`); call `codex-companion.mjs status ... --wait` directly. Run it through `Bash(..., run_in_background: true)` so Claude Code re-invokes you when it exits, then fetch the payload and continue the work the job was gating — that re-invocation is not a checkpoint to hand back to the user.
