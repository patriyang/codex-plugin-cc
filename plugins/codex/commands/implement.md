---
description: Implement a plan via Codex subagent-driven development — dispatch fresh Codex implementer + spec reviewer + code quality reviewer per task
argument-hint: "[--sequential|--single-shot] [--background|--wait] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [plan or path to plan]"
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, TaskCreate, TaskUpdate, TaskList
---

Execute a plan via subagent-driven development with Codex agents in the implementer + spec-reviewer + code-quality-reviewer roles.

This command mirrors the behavior of `superpowers:subagent-driven-development`, but every dispatched subagent is a fresh Codex thread invoked via `codex-companion.mjs task`, not a Claude `Task` tool subagent. Claude is the controller; Codex is the worker.

Raw slash-command arguments:
`$ARGUMENTS`

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
1. Confirm Codex is ready by running `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status --json`. If the helper reports Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
2. Confirm git is in a sane state: `git status --short`. If the working tree is dirty with unrelated changes, tell the user and ask whether to proceed.
3. Confirm we are NOT on `main` / `master`. If we are, tell the user and ask before proceeding — Codex will be committing.

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
git rev-parse HEAD
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

Invoke Codex:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait --write --fresh [--model <m>] [--effort <e>] "<filled prompt>"
```

- Use `--wait` (foreground) so the controller can react. The orchestration is inherently sequential.
- Use `--fresh` so the implementer gets a clean Codex thread.
- Forward `--model` and `--effort` only if the user passed them.
- The prompt is the substituted template text. Pass it as a single positional argument (heredoc/quoting as needed).

### 3. Parse implementer report

Locate the `## Status` heading in Codex's output. Branch on value:

- **NEEDS_CONTEXT** → The operator can unblock with a reply. If Codex listed discrete options, present them via `AskUserQuestion`; otherwise show the questions inline and collect answers. Re-dispatch step 2 with `{{TASK_CONTEXT}}` augmented (or with the operator's decision appended) and `--resume-last` so the implementer keeps its working context.
- **BLOCKED** → The operator alone cannot unblock. Diagnose the specific reason Codex gave:
  - Model/capacity issue → re-dispatch with `--effort high`, then escalate to a stronger model.
  - Codex sandbox or permission denial → check the error, decide whether to grant access or re-scope. Surface to user if unsure.
  - Plan internally inconsistent or wrong → stop and surface to user.
  - Repeated failed attempts → break the task into smaller pieces or escalate.
  Never silently retry without changing model, effort, scope, or plan.
- **DONE_WITH_CONCERNS** → Read the concerns. If they affect correctness or scope, ask the user how to handle before proceeding. If observational, note them and proceed to step 4.
- **DONE** → Proceed to step 4.

### 4. Snapshot head SHA after implementation

```bash
git rev-parse HEAD
```

Record as `HEAD_SHA`. Set `COMMITS_RANGE = ${BASE_SHA}..${HEAD_SHA}`. If `BASE_SHA == HEAD_SHA`, the implementer claimed DONE without committing — treat as BLOCKED and re-dispatch with explicit instruction to commit.

### 5. Dispatch spec reviewer (fresh Codex thread)

Load `${CLAUDE_PLUGIN_ROOT}/prompts/sdd-spec-reviewer.md`. Substitute:
- `{{TASK_NUMBER}}`, `{{TASK_NAME}}`, `{{TASK_TEXT}}`, `{{TASK_CONTEXT}}`
- `{{IMPLEMENTER_REPORT}}` — the full report from step 3
- `{{COMMITS_RANGE}}` — from step 4

Invoke Codex read-only:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait --fresh "<filled prompt>"
```

(No `--write`. Spec reviewer must not edit code.)

### 6. Parse spec reviewer verdict

Locate `## Verdict` heading:
- **SPEC_COMPLIANT** → proceed to step 7.
- **ISSUES_FOUND** → Build a fix brief listing the issues. Re-dispatch implementer (step 2 again) with `{{REVIEWER_FEEDBACK}}` populated and `--resume-last` so the implementer keeps its working context. Then re-dispatch spec reviewer (step 5) — fresh thread each time so it does not anchor on prior judgments. Loop until SPEC_COMPLIANT or until the same issue recurs 3 times (then escalate to user).

### 7. Dispatch code quality reviewer (fresh Codex thread)

Load `${CLAUDE_PLUGIN_ROOT}/prompts/sdd-code-quality-reviewer.md`. Substitute:
- `{{TASK_NUMBER}}`, `{{TASK_NAME}}`, `{{TASK_TEXT}}`
- `{{IMPLEMENTER_SUMMARY}}` — the implementer's summary section
- `{{COMMITS_RANGE}}` — from step 4 (or updated after fix iterations)

Invoke read-only:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait --fresh "<filled prompt>"
```

### 8. Parse code quality verdict

Locate `## Verdict` heading:
- **APPROVED** → mark task complete in TodoWrite, move to next task.
- **CHANGES_REQUESTED** → Build a fix brief from `Issues — Critical` and `Issues — Important` (skip `Minor` unless they're easy). Re-dispatch implementer with `--resume-last`. Then re-dispatch code quality reviewer fresh. Loop until APPROVED or same issue recurs 3 times.

Update TodoWrite as you go.

## Continuous Execution

Once you start, **do not pause to check in with the user between tasks**. Execute every task in the plan continuously. The only reasons to stop:
- A `BLOCKED` status you cannot resolve.
- A `DONE_WITH_CONCERNS` whose concerns affect correctness.
- A review loop hitting the 3-strike cap.
- All tasks complete.

Do not emit "Should I continue?" prompts or progress summaries between tasks. The user asked you to execute the plan.

## Final Review

After every task is complete:

```bash
git log --oneline ${ORIGINAL_BASE_SHA}..HEAD
```

Dispatch one final Codex code review across the entire branch:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --wait --base <original-base>
```

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

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait --write --fresh "<wrapped plan>"
```

Show the report. Propose next steps.

## Argument and Flag Reference

- `--single-shot` → legacy one-Codex-agent mode.
- `--sequential` → explicit SDD mode (also the default).
- `--background` / `--wait` → forwarded to individual `task` invocations. Default is `--wait` for SDD (the orchestration is sequential).
- `--model <m>` / `--effort <e>` → applied to every Codex invocation in this run unless user clears.
- `--resume` / `--fresh` → ignored in SDD mode (the orchestrator picks per-step).

## Failure Modes

- Codex missing/unauthenticated → tell user to run `/codex:setup`.
- Plan unparseable → tell user, suggest `/superpowers:writing-plans`.
- Implementer commits nothing → treated as BLOCKED, re-dispatched with explicit commit instruction.
- Review loop hits 3 strikes on the same issue → stop and surface to user with the full review history.
- Codex output missing required headings → present what came back, tell the user the report was malformed, offer to re-run that step.
