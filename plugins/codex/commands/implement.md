---
description: Implement a plan via Codex subagent-driven development — dispatch fresh Codex implementer + spec reviewer + code quality reviewer per task
argument-hint: "[--sequential|--single-shot] [--background|--wait] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [plan or path to plan]"
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), BashOutput, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
---

Execute a plan via subagent-driven development with Codex agents in the implementer + spec-reviewer + code-quality-reviewer roles.

This command mirrors the behavior of `superpowers:subagent-driven-development`, but every dispatched subagent is a fresh Codex thread invoked via `codex-companion.mjs task`, not a Claude `Task` tool subagent. Claude is the controller; Codex is the worker.

Raw slash-command arguments:
`$ARGUMENTS`

## Git metadata writes

The controller owns Git metadata writes; implementers edit and test only. This includes linked-worktree metadata under `.git/worktrees/` and the representative operations below; apply the same rule to any other Git command that writes metadata. Shell escaping and Git option termination are separate defenses: shell escaping keeps each dynamic value as one argument, while Git's `--` must appear before the first dynamic positional operand so a value beginning with `-` cannot be interpreted as a Git option. Shell-escape every dynamic value as exactly one shell argument before constructing an escalated command. In the examples, `shellEscape(value)` means a robust shell-argument escaping step (for example, Bash `printf '%q' "$value"`); compute each argument separately before interpolation. Values containing whitespace or shell metacharacters must remain one argument. Never interpolate raw values. `WORKTREE_ROOT`, `WORKTREE_PATH`, `REF`, `REMOTE`, and `REFSPEC` are dynamic values below; the fixed commit subject stays literal.

```typescript
const rootArg = shellEscape(WORKTREE_ROOT)
const pathArg = shellEscape(WORKTREE_PATH)
const refArg = shellEscape(REF)
const remoteArg = shellEscape(REMOTE)
const refspecArg = shellEscape(REFSPEC)
```

Invoke each exact metadata-writing operation through its own `Bash` request with `dangerouslyDisableSandbox: true` from the outset; do not first attempt it in `workspace-write` and wait for a sandbox denial.

```typescript
Bash({
  command: `git -C ${rootArg} worktree add -- ${pathArg} ${refArg}`,
  dangerouslyDisableSandbox: true
})

Bash({
  command: `git -C ${rootArg} worktree remove -- ${pathArg}`,
  dangerouslyDisableSandbox: true
})

Bash({
  command: `git -C ${rootArg} add -A`,
  dangerouslyDisableSandbox: true
})

Bash({
  command: `git -C ${rootArg} commit -m "Apply implementation changes"`,
  dangerouslyDisableSandbox: true
})

Bash({
  command: `git -C ${rootArg} fetch -- ${remoteArg} ${refspecArg}`,
  dangerouslyDisableSandbox: true
})

Bash({
  command: `git -C ${rootArg} push -- ${remoteArg} ${refspecArg}`,
  dangerouslyDisableSandbox: true
})
```

Keep read-only Git commands sandboxed in normal `Bash` requests; do not add `dangerouslyDisableSandbox` to commands such as `git status`, `git diff`, or `git rev-parse`. Request approval for one exact operation per request/command. Where a reusable approval is appropriate, use a narrow reusable Git subcommand prefix such as the escaped `git -C ${rootArg} fetch`, never a bare `git` or a broad shell prefix. Do not chain metadata writes with `&&`.

An already-escalated Git command that exits nonzero is an ordinary Git error, not a sandbox failure. Classify an unexpected sandbox failure only when concrete permission-denied evidence is tied to protected Git metadata, such as `.git/index` or `.git/worktrees/<name>/index.lock`.

A denied escalation is the real blocker before execution: stop immediately, report the denied exact operation (including its target), and do not retry unchanged. Do not fall back to the doomed sandbox path.

## Mode

Two execution modes:
- **Sequential SDD (default):** Extract tasks from the plan, then for each task dispatch fresh Codex implementer → spec reviewer → code quality reviewer, with fix loops between reviews. This is the multi-agent flow.
- **Single-shot (`--single-shot`):** Send the entire plan to one Codex agent in one invocation and return its structured report. Same as the previous behavior of this command.

Default to sequential. Switch to single-shot only when `--single-shot` is present in `$ARGUMENTS`.

## Plan Source

The plan source can be (in priority order):
1. Inline prose passed as `$ARGUMENTS` (with the flags stripped).
2. A file path in `$ARGUMENTS` (e.g. `plans/foo.md`) — read it via `Read`.
3. The most recent plan-like content in this Claude conversation (latest assistant or user message that lays out implementation steps / a numbered list / a spec / a checklist). Skip chitchat.

If `$ARGUMENTS` (after flag stripping) is empty or is a phrase like `the plan above`, `previous plan`, `that plan`, `^`, scan conversation history for plan-like content.

Before forwarding (except for inline `$ARGUMENTS` text), show a 1-2 line summary of the plan you extracted (`Plan source: <inline | file <path> | conversation message>`, plus a one-line gist) and ask `AskUserQuestion` once with options `Use this plan (Recommended)` / `Pick a different plan`.

If no plan-like content can be found anywhere, ask the user once what plan to implement.

## Pre-flight Checks

Before extracting tasks:
1. Establish `WORKTREE_ROOT`: run `git rev-parse --show-toplevel` from the controller's working directory (or use the explicit worktree path if the controller already created a dedicated worktree for this task) and record the absolute path as `WORKTREE_ROOT`. This matters because `codex-companion.mjs` resolves its workspace from its own process cwd, which defaults to the harness's main checkout, not the task's worktree — every Codex invocation below passes `-C "${WORKTREE_ROOT}"` so implementers and reviewers target the same tree the controller commits to.
2. Confirm Codex is ready by running `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status -C "${WORKTREE_ROOT}" --json`. If the helper reports Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
3. Confirm git is in a sane state: `git -C "${WORKTREE_ROOT}" status --short`. If the working tree is dirty with unrelated changes, tell the user and ask whether to proceed.
4. Confirm we are NOT on `main` / `master`. If we are, tell the user and ask before proceeding — you (the controller) will be committing each task.

All `git` commands in this loop, and all `codex-companion.mjs` invocations, run against `WORKTREE_ROOT` (via `git -C` / `-C`) rather than the controller's ambient cwd — this keeps the tree Codex edits and the tree the controller commits to in sync.

## Dispatch and Follow-Through

This loop is sequential: the controller cannot take the next step until the current dispatch returns. But implementer and reviewer runs at `xhigh` routinely exceed the foreground `Bash` timeout ceiling, so a foreground call will be killed mid-run and lose the run and its report.

- Dispatch each step with `Bash(..., run_in_background: true)` and let Claude Code re-invoke you when the command exits. Keep foreground `Bash` only for steps you expect to finish well inside the timeout.
- `--json` suppresses progress output to stderr, so stdout stays a single JSON blob. Reading it back with `BashOutput` still parses cleanly for `.rawOutput` and `.threadId`.
- The re-invocation is the next step of this loop, not a fresh request. Read the output, parse the report, and continue through the remaining steps in the same turn.
- **"Dispatched" is never a stopping point.** Do not end a turn with an unread Codex run and a note that you will check back, and do not wait to be told "continue" or "keep going". The loop advances only when you advance it.
- Never abandon a still-running dispatch and re-dispatch on top of it. Two live Codex threads mutating `WORKTREE_ROOT` will corrupt each other's work.
- If a dispatch exits non-zero or returns empty or malformed output, treat it as `BLOCKED` (step 3) rather than assuming the step succeeded.
- If the harness kills a `task` dispatch, the edits are already on disk in `WORKTREE_ROOT`; only the report is lost. Recover its `threadId` with `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status -C "${WORKTREE_ROOT}" --json` (or `result <job-id> --json`), then resume that same thread with `--resume-id "${threadId}"`; do not re-dispatch fresh over the killed run's edits.
- That resume works only for `task` dispatches, which run on persistent threads. A killed `review` (including the Final Review) has nothing to resume — review threads are ephemeral, so their recorded `threadId` does not survive the run. Reviews are read-only and change nothing on disk, so re-dispatch the review from scratch instead.

## Task Extraction

Parse the plan and extract every discrete task:
- Pull the full task text verbatim, not a summary.
- Capture any "context" or "scene-setting" the plan gives for each task.
- Note dependencies between tasks (Task N depends on Task M).

Create TodoWrite items, one per task. Mark Task 1 `in_progress`.

If the plan is too vague to extract tasks (no numbered steps, no checklist, no clear unit-of-work decomposition), STOP and tell the user the plan needs to be more structured first. Suggest `/superpowers:writing-plans`.

## Per-Task Loop (Sequential SDD)

For each task in order:

### 1. Snapshot base SHA

```bash
git -C "${WORKTREE_ROOT}" rev-parse HEAD
```

Record as `BASE_SHA` for this task.

### 2. Dispatch implementer (fresh Codex thread)

Load the implementer prompt template:

```
Read("${CLAUDE_PLUGIN_ROOT}/prompts/sdd-implementer.md")
```

Substitute placeholders:
- `{{TASK_NUMBER}}` — task index
- `{{TASK_NAME}}` — short task name
- `{{TASK_TEXT}}` — full verbatim task text from plan
- `{{TASK_CONTEXT}}` — scene-setting context for this task
- `{{REVIEWER_FEEDBACK}}` — empty on first dispatch

Invoke Codex with `--json` so the controller can read the structured payload:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task -C "${WORKTREE_ROOT}" --write --fresh --json [--model <m>] [--effort <e>] "<filled prompt>"
```

- The controller must have the implementer's report before it can act, so this step blocks the loop. Run it per Dispatch and Follow-Through above rather than as a plain foreground call.
- Use `--fresh` so the implementer gets a clean Codex thread.
- Use `--json` and parse the returned JSON: read `.rawOutput` for the report body (the `## Status` section step 3 inspects) and record `.threadId` as `IMPLEMENTER_THREAD_ID` for this task — it stays fixed for the whole task's fix loop.
- For `--model`, use the user's value if they passed one; otherwise pass `--model gpt-5.6-luna` explicitly. `/codex:implement` defaults to `gpt-5.6-luna` rather than the runtime default of `gpt-5.5`.
- For `--effort`, use the user's value if they passed one; otherwise pass `--effort xhigh` explicitly. `/codex:implement` defaults to `xhigh` rather than the runtime default of `high`.
- The prompt is the substituted template text. Pass it as a single positional argument (heredoc/quoting as needed).

### 3. Parse implementer report

The report body is the `.rawOutput` field of the JSON payload from step 2. Locate the `## Status` heading within it. Branch on value:

- **NEEDS_CONTEXT** → The operator can unblock with a reply. If Codex listed discrete options, present them via `AskUserQuestion`; otherwise show the questions inline and collect answers. Re-dispatch step 2 with `{{TASK_CONTEXT}}` augmented (or with the operator's decision appended) and `--resume-id "${IMPLEMENTER_THREAD_ID}"` so the implementer keeps its working context.
- **BLOCKED** → The operator alone cannot unblock. Diagnose the specific reason Codex gave:
  - Model/capacity issue → re-dispatch one effort step above the run's current effort when the run's model supports the next level; otherwise escalate to a stronger model. The `gpt-5.6-luna` default supports one step above `xhigh` (`max`) but not `ultra`. The run now warns when the model does not advertise the requested level; treat that warning as the escalation not taking effect rather than assuming it did.
  - Codex sandbox or permission denial → check the error, decide whether to grant access or re-scope. Surface to user if unsure.
  - Plan internally inconsistent or wrong → stop and surface to user.
  - Repeated failed attempts → break the task into smaller pieces or escalate.
  Never silently retry without changing model, effort, scope, or plan.
- **DONE_WITH_CONCERNS** → Read the concerns. If they affect correctness or scope, ask the user how to handle before proceeding. If observational, note them and proceed to step 4.
- **DONE** → Proceed to step 4.

### 4. Commit the implementer's work (controller commits, not Codex)

The Codex implementer leaves its changes in the working tree; it does **not** stage or commit. The controller owns both metadata writes and uses the scoped Bash escalation described above: in a worktree, Codex cannot write `.git/worktrees/<name>/index.lock`.

Check for changes:

```bash
git -C "${WORKTREE_ROOT}" status --porcelain
```

- If **empty** (the implementer produced no file changes) yet it reported `DONE` → treat as `BLOCKED`: the implementer did nothing. Re-dispatch step 2 with an explicit instruction to actually make the change.
- Otherwise, stage and commit the changes yourself as two separate controller requests:

```typescript
Bash({
  command: `git -C ${rootArg} add -A`,
  dangerouslyDisableSandbox: true
})

Bash({
  command: `git -C ${rootArg} commit -m "Apply implementation changes"`,
  dangerouslyDisableSandbox: true
})
```

If either already-escalated request returns a nonzero result, stop immediately and report the ordinary Git error; classify it as a sandbox failure only when concrete permission-denied evidence is tied to protected Git metadata. A failed stage must not proceed to commit; a failed commit must not proceed to `rev-parse`, reviewers, or any later task step.

Then, in a normal sandboxed Bash request, read the resulting commit:

```bash
git -C "${WORKTREE_ROOT}" rev-parse HEAD
```

Record the new commit as `HEAD_SHA`. Set `COMMITS_RANGE = ${BASE_SHA}..${HEAD_SHA}` — this is what the reviewers examine.

### 5. Dispatch spec reviewer (fresh Codex thread)

Load `${CLAUDE_PLUGIN_ROOT}/prompts/sdd-spec-reviewer.md`. Substitute:
- `{{TASK_NUMBER}}`, `{{TASK_NAME}}`, `{{TASK_TEXT}}`, `{{TASK_CONTEXT}}`
- `{{IMPLEMENTER_REPORT}}` — the full report from step 3
- `{{COMMITS_RANGE}}` — from step 4

Invoke Codex read-only (same `--model`/`--effort` resolution as step 2 — default `--model gpt-5.6-luna`, `--effort xhigh`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task -C "${WORKTREE_ROOT}" --fresh [--model <m>] [--effort <e>] "<filled prompt>"
```

(No `--write`. Spec reviewer must not edit code.)

### 6. Parse spec reviewer verdict

Locate `## Verdict` heading:
- **SPEC_COMPLIANT** → proceed to step 7.
- **ISSUES_FOUND** → Build a fix brief listing the issues. Re-dispatch implementer (step 2 again) with `{{REVIEWER_FEEDBACK}}` populated and `--resume-id "${IMPLEMENTER_THREAD_ID}"` so the implementer keeps its working context — naming the thread explicitly is what actually preserves it, since `--resume-last` would resolve to the reviewer's thread (the most recently dispatched `task`-class job) instead. After it returns, commit the fix yourself (step 4 — the implementer still does not commit) and update `HEAD_SHA` / `COMMITS_RANGE`. Then re-dispatch spec reviewer (step 5) — fresh thread each time so it does not anchor on prior judgments. Loop until SPEC_COMPLIANT or until the same issue recurs 3 times (then escalate to user).

### 7. Dispatch code quality reviewer (fresh Codex thread)

Load `${CLAUDE_PLUGIN_ROOT}/prompts/sdd-code-quality-reviewer.md`. Substitute:
- `{{TASK_NUMBER}}`, `{{TASK_NAME}}`, `{{TASK_TEXT}}`
- `{{IMPLEMENTER_SUMMARY}}` — the implementer's summary section
- `{{COMMITS_RANGE}}` — from step 4 (or updated after fix iterations)

Invoke read-only (same `--model`/`--effort` resolution as step 2 — default `--model gpt-5.6-luna`, `--effort xhigh`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task -C "${WORKTREE_ROOT}" --fresh [--model <m>] [--effort <e>] "<filled prompt>"
```

### 8. Parse code quality verdict

Locate `## Verdict` heading:
- **APPROVED** → mark task complete in TodoWrite, move to next task.
- **CHANGES_REQUESTED** → Build a fix brief from `Issues — Critical` and `Issues — Important` (skip `Minor` unless they're easy). Re-dispatch implementer with `--resume-id "${IMPLEMENTER_THREAD_ID}"` so it resumes its own thread rather than the reviewer's. After it returns, commit the fix yourself (step 4) and update `HEAD_SHA` / `COMMITS_RANGE`. Then re-dispatch code quality reviewer fresh. Loop until APPROVED or same issue recurs 3 times.

Update TodoWrite as you go.

## Continuous Execution

Once you start, **do not pause to check in with the user between tasks**. Execute every task in the plan continuously. The only reasons to stop:
- A `BLOCKED` status you cannot resolve.
- A `DONE_WITH_CONCERNS` whose concerns affect correctness.
- A review loop hitting the 3-strike cap.
- All tasks complete.

Do not emit "Should I continue?" prompts or progress summaries between tasks. The user asked you to execute the plan.

Waiting on a dispatched Codex run is not one of those reasons. If a step is still running, wait it out (see Dispatch and Follow-Through); having to be prompted to resume the loop is a failure of this command.

## Final Review

After every task is complete:

```bash
git -C "${WORKTREE_ROOT}" log --oneline ${ORIGINAL_BASE_SHA}..HEAD
```

Dispatch one final Codex code review across the entire branch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review -C "${WORKTREE_ROOT}" --base <original-base>
```

Dispatch this review with `Bash(..., run_in_background: true)` per **Dispatch and Follow-Through**: branch-wide review is the longest call; `review` runs in the foreground inside the script, and `--background` does not detach it — Claude Code's `run_in_background` is what does.

Present its output verbatim. Then suggest `superpowers:finishing-a-development-branch` to wrap up.

## Aggregated Report

After everything finishes (or after stopping due to an unresolvable blocker), output a final controller report to the user:

```
## Tasks Completed
- Task N: [name] — APPROVED
- ...

## Tasks Blocked
- Task M: [name] — [reason]

## Bugs Flagged Across Tasks
- ...

## Deviations From Plan
- ...

## Next Steps
- ...
```

This is the aggregate of every implementer/reviewer report and is what Claude uses for follow-up planning.

## Single-Shot Mode (`--single-shot`)

If the user passed `--single-shot`, skip task extraction and the per-task loop. Instead, wrap the full plan in the legacy implementer prompt (asking for the four-section report: Accomplished / Bugs Flagged / Deviations From Plan / Next Steps) and invoke Codex once:

Dispatch this single-shot task with `Bash(..., run_in_background: true)` per **Dispatch and Follow-Through**: one Codex agent handling the entire plan is the longest possible call.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task -C "${WORKTREE_ROOT}" --write --fresh [--model <m>] [--effort <e>] "<wrapped plan>"
```

(Same `--model`/`--effort` resolution as sequential mode — default `--model gpt-5.6-luna`, `--effort xhigh` unless the user passed one.)

The single-shot Codex agent leaves its changes unstaged and uncommitted too (same sandbox limitation). After it returns, stage and commit the working-tree changes yourself as two separate controller requests:

```bash
git -C "${WORKTREE_ROOT}" status --porcelain   # if empty, Codex made no changes — report that instead of committing
```

```typescript
Bash({
  command: `git -C ${rootArg} add -A`,
  dangerouslyDisableSandbox: true
})

Bash({
  command: `git -C ${rootArg} commit -m "Apply implementation changes"`,
  dangerouslyDisableSandbox: true
})
```

If either already-escalated request returns a nonzero result, stop immediately and report the ordinary Git error; classify it as a sandbox failure only when concrete permission-denied evidence is tied to protected Git metadata. A failed stage must not proceed to commit; a failed commit must not proceed to `rev-parse`, reviewers, or any later flow step.

Show the report. Propose next steps.

## Argument and Flag Reference

- `--single-shot` → legacy one-Codex-agent mode.
- `--sequential` → explicit SDD mode (also the default).
- `--background` / `--wait` → Claude-side execution control only. Do not forward either to `task`: `task` now accepts `--wait` as an explicit no-op (foreground is `task`'s default), so there is nothing to forward — SDD always blocks on each dispatch regardless, see Dispatch and Follow-Through.
- `--model <m>` / `--effort <e>` → applied to every Codex invocation in this run. If omitted, `--model` defaults to `gpt-5.6-luna` and `--effort` defaults to `xhigh` (both passed explicitly by this command, overriding the runtime defaults of `gpt-5.5` / `high`).
- `-C "${WORKTREE_ROOT}"` → applied to every Codex invocation in this run (established in Pre-flight Checks). Pins the implementer/reviewer workspace to the task's worktree instead of `codex-companion.mjs`'s default of the controller's own process cwd.
- `--resume` / `--fresh` → ignored in SDD mode (the orchestrator picks per-step). SDD resumes the implementer by explicit thread id via `--resume-id "${IMPLEMENTER_THREAD_ID}"` (not `--resume-last`, which would resolve to whichever `task`-class thread was dispatched most recently — often a reviewer, not the implementer).

## Failure Modes

- Codex missing/unauthenticated → tell user to run `/codex:setup`.
- Plan unparseable → tell user, suggest `/superpowers:writing-plans`.
- Implementer produces no file changes → treated as BLOCKED, re-dispatched with explicit instruction to make the change. (The controller does the committing; Codex is not expected to commit.)
- Review loop hits 3 strikes on the same issue → stop and surface to user with the full review history.
- Codex output missing required headings → present what came back, tell the user the report was malformed, offer to re-run that step.
