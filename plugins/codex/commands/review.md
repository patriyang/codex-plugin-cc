---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a Codex review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, run the review in the foreground.
- If the raw arguments include `--background`, enqueue the review as a detached tracked job.
- Otherwise, decide the mode yourself. Never ask the user; do not use `AskUserQuestion`. Estimate the review size first:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Choose the foreground only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, choose the background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Tell the user which mode you chose and why in one short line, then proceed to that flow without waiting for confirmation. For example: "Sizable change, running the review in the background." or "Small change, running the review in the foreground."

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script accepts `--wait` and `--background` as mutually exclusive flags. `--background` detaches the review as a tracked job and returns its job ID immediately; the background flow also passes `--json` so the controller can read that ID deterministically.
- `/codex:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- If the command prints a `[codex] ` line on stderr, surface that line above the output before returning stdout verbatim. Those lines report an argument the script could not honor, and the run still exits 0.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Enqueue the review from a foreground `Bash` call. Keep the generated flags and the preserved raw arguments in one string so the companion script can parse them together:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "--background --json $ARGUMENTS"
```
- Read `jobId` and `workspaceRoot` from the returned JSON, then block with a bounded foreground wait. The `Bash` tool timeout must be comfortably larger than `--timeout-ms`:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status -C "${workspaceRoot}" ${jobId} --wait --timeout-ms 240000 --json`,
  description: "Wait for Codex review",
  timeout: 300000
})
```
- If the wait payload has `waitTimedOut: true`, follow the PID-aware timeout branch in `status.md` and re-arm only when it classifies the job as healthy. Otherwise, read the persisted result:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result -C "${workspaceRoot}" <job-id> --json
```
- Read `.storedJob.rendered` from the result JSON and present it verbatim in the same turn the terminal wait returns. Do not wait to be asked "is it done?" or "continue".
- If enqueueing or reading the job exits non-zero, the job reaches `failed` or `cancelled`, or the JSON or review output is empty or malformed, say so and surface the most actionable failure lines. A failed review must not vanish silently.
- Never re-dispatch a second review over the same diff, and never hand the user a "check `/codex:status`" note in place of the findings.
- If you ever enter a later turn holding a dispatched-but-unread review, recover it from disk with `status -C "${workspaceRoot}" <job-id> --json`; if it is still active, resume the bounded wait, and when it is terminal use `result -C "${workspaceRoot}" <job-id> --json`. Do not re-dispatch it or report it as stuck.
