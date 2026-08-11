---
description: Run a deep Codex review covering correctness, conciseness, and code quality
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [focus ...]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run a deep Codex review through the shared plugin runtime.
Position it as a thorough, multi-dimensional pass that evaluates the change across three lenses in one review: correctness, conciseness (the same intent as a `/simplify` pass), and code quality.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.
- Keep the framing on all three dimensions: is the code correct, could it be more concise, and does it meet the quality bar.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, enqueue the deep review as a detached tracked job.
- Otherwise, decide the mode yourself. Never ask the user; do not use `AskUserQuestion`. Estimate the review size first:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Choose the foreground only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, choose the background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Tell the user which mode you chose and why in one short line, then proceed to that flow without waiting for confirmation. For example: "Sizable change, running the deep review in the background." or "Small change, running the deep review in the foreground."

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the deep-review framing or rewrite the user's focus text.
- The companion script accepts `--wait` and `--background` as mutually exclusive flags. `--background` now enqueues the deep review as a tracked job and returns its job ID immediately; add `--json` in the background flow so that ID is machine-readable.
- `/codex:deep-review` uses the same review target selection as `/codex:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Like `/codex:adversarial-review`, it can take extra focus text after the flags.
- Flags must come before the focus text; once the focus text starts, anything after it (including something that looks like a flag) is treated as literal text.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" deep-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- If the command prints a `[codex] ` line on stderr, surface that line above the output before returning stdout verbatim. Those lines report an argument the script could not honor, and the run still exits 0.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Enqueue the deep review in foreground `Bash`, keeping the added flags and the user's raw arguments inside one argument for the companion parser:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" deep-review "--background --json $ARGUMENTS"
```
- Parse `jobId` and `workspaceRoot` from the enqueue response. Await it through foreground `Bash`, giving the tool a timeout comfortably above the bounded status wait:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status -C "${workspaceRoot}" ${jobId} --wait --timeout-ms 240000 --json`,
  description: "Wait for Codex deep review",
  timeout: 300000
})
```
- When the JSON says `waitTimedOut: true`, use the PID-aware timeout branch in `status.md` and re-arm only a healthy job. When it does not, retrieve the persisted deep-review result:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result -C "${workspaceRoot}" <job-id> --json
```
- Read `.storedJob.rendered` from the result JSON and present it verbatim in the same turn the terminal wait returns; never wait for the user to ask "is it done?" or "continue".
- If enqueueing or result retrieval exits non-zero, the job becomes `failed` or `cancelled`, or the JSON or review output is empty or malformed, report the failure with the most actionable lines. A failed review must not vanish silently.
- Never re-dispatch another deep review over the same diff, and never replace the findings with a "check `/codex:status`" note.
- If a later turn inherits a dispatched-but-unread deep review, use `status <job-id> --json` to recover it from disk, resume the bounded wait while active, and call `result <job-id> --json` after it is terminal. Do not re-dispatch or describe the job as stuck.
