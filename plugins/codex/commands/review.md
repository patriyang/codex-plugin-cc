---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), BashOutput
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
- If the raw arguments include `--background`, run the review in a Claude background task.
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
- The companion script accepts `--wait` and `--background` as mutually exclusive flags, but it does not itself background the review; Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/codex:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"`,
  description: "Codex review",
  run_in_background: true
})
```
- Launch it, tell the user in one line that the review is running, and end the turn. Do not poll `BashOutput` in a loop while it runs.
- Claude Code re-invokes you when the command exits. That re-invocation is the second half of this command, not a fresh request: read the output with `BashOutput` and present the review in that same turn. Do not wait to be asked "is it done?" or "continue".
- If it exited non-zero, or the output is empty or malformed, say so and surface the most actionable stderr lines. A failed review must not vanish silently.
- Never re-dispatch a second review over the same diff, and never hand the user a "check `/codex:status`" note in place of the findings. A background review is a plain shell — it mints no job id, so `/codex:status` has nothing to show for it.
