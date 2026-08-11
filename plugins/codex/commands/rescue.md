---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`) in the foreground, forwarding the raw user request as the prompt.
`codex:codex-rescue` is a subagent, not a skill — do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Codex's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- Always invoke the `codex:codex-rescue` subagent in the foreground. `--background` backgrounds the tracked Codex task inside that subagent; it never backgrounds the `Agent` call.
- If the request includes `--background`, have the foreground subagent enqueue the Codex task with `task --background --json`.
- If the request includes `--wait`, have the foreground subagent run the Codex task in the foreground.
- If neither flag is present, invoke the subagent in the foreground and let it apply its self-chosen foreground/background guidance for the Codex task.
- `--background` and `--wait` are mutually exclusive execution flags. Never dispatch both; reject that combination before invoking the subagent.
- `--wait` remains a foreground execution flag: strip it before invoking `task`, and do not treat it as natural-language task text. `--background` is forwarded to `task` as `--background --json`, and neither execution flag belongs in the natural-language task text.
- In the foreground flow, the subagent's stdout is Codex's result. In the background flow, the subagent's stdout is the enqueue JSON; the controller reads `jobId` and `workspaceRoot`, waits, and fetches the persisted result.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The controller always invokes the subagent in the foreground. The subagent is a thin forwarder only: it uses exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...` and returns that command's stdout as-is.
- The subagent never waits, polls, fetches, or cancels a background task. The controller owns the bounded wait and persisted-result fetch.
- Return the subagent stdout verbatim to the user in the foreground flow; in the background flow, treat it as dispatch JSON until the controller has read and presented `.storedJob.rendered`.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own. Do not route the controller's wait through `/codex:status`; `disable-model-invocation: true` means that slash command cannot be invoked by the model, so use the direct companion `status` Bash call below.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort; the runtime defaults to `high`.
- Leave the model unset unless the user explicitly asks for one; the runtime defaults to `gpt-5.5`. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

Foreground flow:

- Invoke `codex:codex-rescue` through the foreground `Agent` call. The subagent runs one foreground `task` invocation without passing `--wait` and returns its stdout.
- This foreground flow applies to a rescue report. If the no-flag subagent guidance selects background and returns `task --background --json` enqueue JSON, treat that dispatch JSON as a request to follow the Background flow; do not return it as the rescue result.
- Return a foreground rescue report verbatim, with no commentary before or after it.

Background flow:

- Invoke `codex:codex-rescue` through the foreground `Agent` call. Tell the subagent to use exactly one `Bash` call for `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background --json ...`, return the enqueue payload, and do no waiting, polling, or result fetching.
- Treat the subagent stdout as dispatch JSON. Read `jobId` and `workspaceRoot` from it, then block with a bounded foreground wait. Both are dynamic values: shell-escape each exactly once before building the command. `shellEscape(value)` means robust shell argument escaping (for example, Bash `printf '%q' "$value"`). Keep `--` before the job ID, and keep `"${CLAUDE_PLUGIN_ROOT}"` double quoted because the shell expands it. The `Bash` tool timeout must be comfortably larger than `--timeout-ms`:
```typescript
const rootArg = shellEscape(workspaceRoot)
const jobArg = shellEscape(jobId)

Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status -C ${rootArg} --wait --timeout-ms 240000 --json -- ${jobArg}`,
  description: "Wait for Codex rescue",
  timeout: 300000
})
```
- If the wait payload has `waitTimedOut: true`, follow the PID-aware timeout branch in `status.md` and re-arm only when it classifies the job as healthy. Otherwise, read the persisted result:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result -C ${rootArg} --json -- ${jobArg}`,
  description: "Read persisted Codex rescue result"
})
```
- Read `.storedJob.rendered` from the result JSON and present it verbatim in the same turn the terminal wait returns. Do not replace the rescue result with a status note or wait to be asked "is it done?" or "continue".
- If enqueueing or reading the job exits non-zero, the job reaches `failed` or `cancelled`, or the dispatch JSON, result JSON, or rescue output is empty or malformed, report the failure and surface the most actionable failure lines. Empty or malformed Agent/Bash output, or a reported nonzero Agent invocation, must surface the available tool and stderr failure lines; never silently treat it as a successful rescue. A failed rescue must not vanish silently.
- Never re-dispatch a second rescue for the same request. Do not close out a turn with a dispatched-but-unread rescue or a "check `/codex:status`" note in place of its result.
- If a later turn inherits a dispatched-but-unread rescue, recover it from disk with `status -C ${rootArg} --json -- ${jobArg}`; if it is still active, resume the bounded wait, and when it is terminal use `result -C ${rootArg} --json -- ${jobArg}`. Do not re-dispatch it or report it as stuck.
