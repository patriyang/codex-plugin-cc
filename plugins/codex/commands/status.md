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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status <job-id> --wait [--timeout-ms <ms>]
```

- It returns as soon as that job reaches a terminal state, and it re-reads the job record each poll, so a job whose process died is reaped and reported instead of blocking forever.
- `--wait` requires a job ID. Without one it errors out rather than waiting on the whole table.
- The default timeout is 240000 ms. If the payload comes back with `waitTimedOut: true`, the job is still running — re-arm the same wait, do not report the job as stuck or abandoned.
- Never hand-roll a poll loop that greps the bare `status` table for `running` or `succeeded`. A stale record from a dead process keeps a generic matcher spinning forever; the job-scoped `--wait` is the only form that terminates reliably.
- Run the wait through `Bash(..., run_in_background: true)` so Claude Code re-invokes you when it exits. Treat that re-invocation as your cue to fetch the result with `/codex:result <job-id>` and continue the work the job was gating — not as a checkpoint to hand back to the user.
