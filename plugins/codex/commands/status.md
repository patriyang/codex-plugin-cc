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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status <job-id> --wait --timeout-ms 240000 --json
```

- It returns as soon as that job reaches a terminal state, and it re-reads the job record each poll, so a job whose process died is reaped and reported rather than blocking for the full timeout. (A job that never got a PID — a failed spawn — is not reapable and will block until the timeout.)
- `--wait` requires a job ID. Without one it errors out rather than waiting on the whole table.
- The default timeout matches `DEFAULT_STATUS_WAIT_TIMEOUT_MS` in `codex-companion.mjs`. On timeout the command still exits 0, and the only signal is `waitTimedOut: true` in the payload — which is why the invocation above passes `--json`. The plain-text renderer drops that field.
- On `waitTimedOut: true`, inspect `job.status` and `job.pid` in the JSON payload before deciding whether to re-arm:
  - A job that is `running`, or `queued` with a finite `job.pid`, is healthy. Re-arm the same bounded wait; do not report it as stuck or abandoned.
  - A job still `queued` with a null or absent `job.pid` after the full wait window is a failed spawn that cannot be reaped. Stop re-arming and report a failed dispatch, surfacing the job ID and its job record.
- Never hand-roll a poll loop that greps the bare `status` table. A stale record from a dead process keeps a generic matcher spinning forever, and the status vocabulary is `queued` / `running` / `completed` / `failed` / `cancelled` (plus `stalled` in the renderer) — a loop watching for `succeeded` waits on a string this runtime never emits. The job-scoped `--wait` is the only form that terminates reliably.
- Every tracked run persists a job record. `task --background` and `review --background`, `adversarial-review --background`, and `deep-review --background` all enqueue detached work and immediately return a job ID that can be passed to this wait.
- Claude cannot invoke this slash command (`disable-model-invocation: true`); a controller waiting on behalf of another flow must call `codex-companion.mjs status ... --wait` directly in a foreground `Bash` call. Set the `Bash` tool's timeout comfortably larger than `--timeout-ms`; if the JSON says `waitTimedOut: true`, apply the PID-aware timeout branch above. Once the payload is terminal, read the persisted output with `codex-companion.mjs result <job-id> --json` and continue the work it gated.
- A foreground `Bash` call that returns always continues the current turn, so this bounded-wait pattern never depends on Claude Code re-invoking a stopped caller. That re-invocation has been observed not to arrive for subagent callers, leaving a completed Codex result unread with no signal.
