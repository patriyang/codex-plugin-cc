---
description: Run a Codex review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [focus ...]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

Run an adversarial Codex review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, enqueue the adversarial review as a detached tracked job.
- Otherwise, decide the mode yourself. Never ask the user; do not use `AskUserQuestion`. Estimate the review size first:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Choose the foreground only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, choose the background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Tell the user which mode you chose and why in one short line, then proceed to that flow without waiting for confirmation. For example: "Sizable change, running the adversarial review in the background." or "Small change, running the adversarial review in the foreground."

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script accepts `--wait` and `--background` as mutually exclusive flags. With `--background`, it detaches the adversarial review, persists a tracked job, and immediately returns the job ID; pass `--json` in the background flow to capture that ID.
- `/codex:adversarial-review` uses the same review target selection as `/codex:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `/codex:review`, it can still take extra focus text after the flags.
- Flags must come before the focus text; once the focus text starts, anything after it (including something that looks like a flag) is treated as literal text.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- If the command prints a `[codex] ` line on stderr, surface that line above the output before returning stdout verbatim. Those lines report an argument the script could not honor, and the run still exits 0.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Start the adversarial review from foreground `Bash`. Put the generated flags and unchanged raw arguments in the same string so they are parsed as one command line:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review "--background --json $ARGUMENTS"
```
- Extract `jobId` from that JSON and wait for that job in a foreground `Bash` call whose tool timeout is comfortably larger than the companion timeout:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status ${jobId} --wait --timeout-ms 240000 --json`,
  description: "Wait for Codex adversarial review",
  timeout: 300000
})
```
- On `waitTimedOut: true`, apply the PID-aware timeout branch in `status.md`; repeat the bounded wait only for a healthy job. After a terminal payload, load the stored result:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result <job-id> --json
```
- Read `.storedJob.rendered` from the result JSON and return it verbatim in the same turn the terminal wait returns. Do not wait for "is it done?" or "continue".
- If the enqueue or read fails, the job ends as `failed` or `cancelled`, or any JSON or review output is empty or malformed, report that and include the most actionable failure lines. A failed review must not vanish silently.
- Never re-dispatch a second adversarial review over the same diff, and never substitute a "check `/codex:status`" note for its findings.
- If a dispatched adversarial review is unread when a later turn begins, recover its record with `status <job-id> --json`; continue the bounded wait if active, then use `result <job-id> --json` once terminal. Do not launch a duplicate or call the existing run stuck.
