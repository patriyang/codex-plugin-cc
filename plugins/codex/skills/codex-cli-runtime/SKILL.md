---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task [--write] [--background --json] [--model <m>] [--effort <e>] [--resume-last|--fresh] -- "<prompt text>"`

The bare `--` guarantees the prompt reaches Codex verbatim even when its first word is a flag name like `--write`, which would otherwise be consumed as a real flag and silently flip the sandbox to workspace-write.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged. The controller owns waiting and result retrieval; the subagent does not monitor, poll, fetch, or cancel.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `deep-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort; the runtime defaults to `high`.
- Leave model unset by default for task requests; the runtime defaults to `gpt-5.5`. Review commands resolve their own defaults: `/codex:deep-review` uses `gpt-5.6-sol` with `high` effort, and each review's output names the model it ran under — plus the effort, except for the native `/codex:review`, which sends none. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--wait`, remove it before invoking `task`; foreground `task` is already the default, and it must not enter the natural-language task text. If the forwarded request includes `--background`, pass `--background --json` to `task`; return its enqueue JSON without waiting, polling, or fetching, and do not include the flag in the prompt. The `task` contract is flags first, then a bare `--`, then the prompt, which makes the whole prompt literal regardless of its first word.
- `--background` and `--wait` are mutually exclusive execution flags. Do not forward or dispatch both; reject that combination before the single `task` invocation.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Support is per model: the plugin warns when the resolved model does not advertise the requested level, and Codex's handling of an unadvertised level is inconsistent—it may silently accept it or fail mid-turn with an upstream 400.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return nothing.
