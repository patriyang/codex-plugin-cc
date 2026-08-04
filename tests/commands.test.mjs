import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command auto-decides execution mode and uses background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.doesNotMatch(source, /allowed-tools:.*AskUserQuestion/);
  assert.match(source, /Never ask the user/i);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex review"/);
  assert.match(source, /Do not poll `BashOutput` in a loop/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Choose the foreground only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, choose the background/i);
  assert.match(source, /The companion script[^.\n]*does not itself background the review/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /Tell the user which mode you chose/i);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command auto-decides execution mode and uses background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.doesNotMatch(source, /allowed-tools:.*AskUserQuestion/);
  assert.match(source, /Never ask the user/i);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[--model <model\|spark>\] \[--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex adversarial review"/);
  assert.match(source, /Do not poll `BashOutput` in a loop/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Choose the foreground only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, choose the background/i);
  assert.match(source, /The companion script[^.\n]*does not itself background the review/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /Tell the user which mode you chose/i);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
  assert.match(source, /Flags must come before the focus text/i);
});

test("deep review command auto-decides execution mode and uses background Bash while staying review-only", () => {
  const source = read("commands/deep-review.md");
  assert.doesNotMatch(source, /allowed-tools:.*AskUserQuestion/);
  assert.match(source, /Never ask the user/i);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Codex's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /deep-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[--model <model\|spark>\] \[--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" deep-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Codex deep review"/);
  assert.match(source, /Do not poll `BashOutput` in a loop/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Choose the foreground only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, choose the background/i);
  assert.match(source, /The companion script[^.\n]*does not itself background the review/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /Tell the user which mode you chose/i);
  assert.match(source, /uses the same review target selection as `\/codex:review`/i);
  assert.match(source, /correctness/i);
  assert.match(source, /conciseness/i);
  assert.match(source, /code quality/i);
  assert.match(source, /can take extra focus text after the flags/i);
  assert.match(source, /Flags must come before the focus text/i);
  // Argument hint advertises the model/effort override flags.
  assert.match(source, /\[--model <model\|spark>\] \[--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>\]/);
  // README documents the deep-review defaults so command + docs cannot drift.
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /`\/codex:deep-review` uses `gpt-5\.6-sol` with `medium` reasoning effort/);
});

test("implement command defaults to gpt-5.6-luna at xhigh effort", () => {
  const source = read("commands/implement.md");
  // Step 2 default-resolution instructions.
  assert.match(source, /otherwise pass `--model gpt-5\.6-luna` explicitly/);
  assert.match(source, /`\/codex:implement` defaults to `gpt-5\.6-luna` rather than the runtime default of `gpt-5\.5`/);
  assert.match(source, /otherwise pass `--effort xhigh` explicitly/);
  assert.match(source, /`\/codex:implement` defaults to `xhigh` rather than the runtime default of `high`/);
  // Reviewer + single-shot steps reuse the same defaults.
  assert.match(source, /default `--model gpt-5\.6-luna`, `--effort xhigh`/);
  // Flag reference states both defaults.
  assert.match(
    source,
    /`--model` defaults to `gpt-5\.6-luna` and `--effort` defaults to `xhigh`/
  );
  // Old defaults must not linger anywhere in the command prose.
  assert.doesNotMatch(source, /default `--effort medium`/);

  // README must document the same defaults so command + docs cannot drift.
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /`\/codex:implement` uses `gpt-5\.6-luna` with `xhigh` reasoning effort/);
});

test("implement routes Git metadata writes through scoped controller escalation", () => {
  const source = read("commands/implement.md");
  const boundaryStart = source.indexOf("## Git metadata writes");
  assert.notEqual(boundaryStart, -1, "implement documents the Git metadata boundary");
  const boundary = source.slice(boundaryStart, source.indexOf("## Plan Source", boundaryStart));

  const escalatedCommands = [...boundary.matchAll(
    /Bash\(\{\s*command:\s*`([^`]+)`,\s*dangerouslyDisableSandbox:\s*true\s*\}\)/g
  )].map((match) => match[1]);
  const allEscalatedCommands = [...source.matchAll(
    /Bash\(\{\s*command:\s*`([^`]+)`,\s*dangerouslyDisableSandbox:\s*true\s*\}\)/g
  )].map((match) => match[1]);
  for (const operation of [
    "worktree add",
    "worktree remove",
    "add -A",
    "commit",
    "fetch",
    "push"
  ]) {
    assert.ok(
      escalatedCommands.some((command) => command.startsWith(`git -C \${rootArg} ${operation}`)),
      `${operation} is a directly escalated controller operation`
    );
  }

  assert.match(boundary, /from the outset|before the first attempt/i);
  assert.match(boundary, /read-only Git commands[^\n]*sandboxed/i);
  assert.match(boundary, /one exact operation per (?:approval )?request|one exact operation per command/i);
  assert.match(boundary, /narrow reusable Git subcommand prefix/i);
  assert.match(boundary, /do not chain[^\n]*metadata writes[^\n]*&&/i);
  assert.match(boundary, /nonzero[^\n]*ordinary Git (?:failure|error)/i);
  assert.match(boundary, /concrete permission-denied evidence[^\n]*protected Git metadata/i);

  for (const section of [
    source.slice(source.indexOf("### 4. Commit the implementer's work"), source.indexOf("### 5. Dispatch spec reviewer")),
    source.slice(source.indexOf("## Single-Shot Mode"), source.indexOf("## Argument and Flag Reference"))
  ]) {
    assert.match(section, /Bash\(\{\s*command:\s*`git -C \$\{rootArg\} add -A`,\s*dangerouslyDisableSandbox:\s*true\s*\}\)/);
    assert.match(section, /Bash\(\{\s*command:\s*`git -C \$\{rootArg\} commit [^`]+`,\s*dangerouslyDisableSandbox:\s*true\s*\}\)/);
    assert.doesNotMatch(section, /git -C \$\{rootArg\} add -A\s*&&/);
    assert.match(section, /nonzero[^\n]*stop immediately[^\n]*ordinary Git error/i);
    assert.match(section, /failed stage[^\n]*must not[^\n]*commit/i);
    assert.match(section, /failed commit[^\n]*(?:must not|do not)[^\n]*(?:rev-parse|reviewer)/i);
  }

  const sequential = source.slice(
    source.indexOf("### 4. Commit the implementer's work"),
    source.indexOf("### 5. Dispatch spec reviewer")
  );
  assert.match(sequential, /command:\s*`git -C \$\{rootArg\} commit -m \"Apply implementation changes\"`/);
  assert.doesNotMatch(sequential, /command:\s*`git -C [^`]* commit [^`]*\$\{TASK_NAME\}/);

  const singleShot = source.slice(
    source.indexOf("## Single-Shot Mode"),
    source.indexOf("## Argument and Flag Reference")
  );
  for (const section of [sequential, singleShot]) {
    assert.match(section, /command:\s*`git -C \$\{rootArg\} commit -m \"Apply implementation changes\"`/);
    assert.doesNotMatch(section, /command:\s*`git -C [^`]* commit [^`]*(?:\$\{[^}]+\}|<[^>]+>)/);
  }

  for (const snippet of [
    /git -C \"\$\{WORKTREE_ROOT\}\" status\b/,
    /git -C \"\$\{WORKTREE_ROOT\}\" rev-parse\b/,
    /git -C \"\$\{WORKTREE_ROOT\}\" log\b/
  ]) {
    assert.match(source, snippet, `implement includes read-only Git snippet ${snippet}`);
    assert.doesNotMatch(allEscalatedCommands.join("\n"), snippet, `read-only Git command is not escalated: ${snippet}`);
  }
});

test("privileged Git examples require one shell-escaped argument per dynamic value", () => {
  const source = read("commands/implement.md");
  const boundaryStart = source.indexOf("## Git metadata writes");
  const boundary = source.slice(boundaryStart, source.indexOf("## Plan Source", boundaryStart));

  assert.match(boundary, /shell-escape every dynamic value as exactly one shell argument before constructing an escalated command/i);
  assert.match(boundary, /whitespace|shell metacharacters/i);
  assert.match(boundary, /never interpolate raw values/i);
  assert.match(boundary, /shellEscape\(value\)/);
  assert.match(boundary, /printf '%q' "\$value"/);

  for (const value of [
    "WORKTREE_ROOT",
    "WORKTREE_PATH",
    "REF",
    "REMOTE",
    "REFSPEC"
  ]) {
    assert.match(boundary, new RegExp(`shellEscape\\(${value}\\)`), `${value} is escaped before interpolation`);
  }

  assert.doesNotMatch(boundary, /\$\{WORKTREE_ROOT\}.*(?:<path>|<ref>|<remote>|<refspec>)/s);
  assert.doesNotMatch(boundary, /(?:<path>|<ref>|<remote>|<refspec>)/);
});

test("privileged Git examples terminate option parsing before dynamic operands", () => {
  const source = read("commands/implement.md");
  const boundaryStart = source.indexOf("## Git metadata writes");
  const boundary = source.slice(boundaryStart, source.indexOf("## Plan Source", boundaryStart));

  assert.match(boundary, /shell escaping and Git option termination are separate defenses/i);

  for (const command of [
    "git -C ${rootArg} worktree add -- ${pathArg} ${refArg}",
    "git -C ${rootArg} worktree remove -- ${pathArg}",
    "git -C ${rootArg} fetch -- ${remoteArg} ${refspecArg}",
    "git -C ${rootArg} push -- ${remoteArg} ${refspecArg}"
  ]) {
    assert.ok(
      boundary.includes("command: `" + command + "`"),
      `${command} terminates Git option parsing before dynamic operands`
    );
  }

  assert.match(boundary, /command: `git -C \$\{rootArg\} add -A`/);
  assert.match(boundary, /command: `git -C \$\{rootArg\} commit -m "Apply implementation changes"`/);
});

test("implementer prompt keeps Git metadata and PR/issue mutation controller-owned", () => {
  const prompt = read("prompts/sdd-implementer.md");
  const role = prompt.slice(prompt.indexOf("<role>"), prompt.indexOf("</role>"));
  const escalation = prompt.slice(prompt.indexOf("<escalation>"), prompt.indexOf("</escalation>"));

  assert.match(role, /do not perform any Git metadata-writing operation/i);
  assert.match(role, /do not mutate (?:pull requests?|PRs?) or issues/i);
  assert.match(escalation, /permission blocker/i);
  assert.match(escalation, /exact command, path, error, and intended effect/i);
});

test("implementer prompt prohibits every Git metadata write and reports it to the controller", () => {
  const prompt = read("prompts/sdd-implementer.md");
  const role = prompt.slice(prompt.indexOf("<role>"), prompt.indexOf("</role>"));

  assert.match(role, /do not perform any Git metadata-writing operation/i);
  for (const operation of [
    "fetch",
    "branch",
    "tag",
    "stash",
    "reset",
    "staging",
    "committing",
    "pushing",
    "worktree"
  ]) {
    assert.match(role, new RegExp(`\\b${operation}\\b`, "i"), `${operation} is explicitly prohibited`);
  }
  assert.match(role, /report the exact operation[^\n]*controller/i);
  assert.match(role, /do not attempt it/i);
});

test("implement stops on a denied escalation without retry or sandbox fallback", () => {
  const source = read("commands/implement.md");
  const boundaryStart = source.indexOf("## Git metadata writes");
  const boundary = source.slice(boundaryStart, source.indexOf("## Plan Source", boundaryStart));

  assert.match(boundary, /a denied escalation is the real blocker/i);
  assert.match(boundary, /stop immediately/i);
  assert.match(boundary, /report the denied exact operation/i);
  assert.match(boundary, /do not retry unchanged/i);
  assert.match(boundary, /do not fall back to the doomed sandbox path/i);
});

test("README install steps use the marketplace name this repo actually declares", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".claude-plugin", "marketplace.json"), "utf8")
  );
  const name = marketplace.name;
  const pluginName = marketplace.plugins[0].name;

  // Regression for #85: the install block named `codex@openai-codex`, a handle
  // that does not exist for this repo, while the update line below it already
  // used the declared name. Pin every `/plugin` handle to marketplace.json.
  assert.match(readme, new RegExp(`/plugin install ${pluginName}@${name}\\b`));
  assert.match(readme, new RegExp(`/plugin marketplace update ${name}\\b`));
  assert.doesNotMatch(readme, /@openai-codex\b/);
});

test("README documents per-command model/effort defaults, not one global default", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtime = fs.readFileSync(
    path.join(PLUGIN_ROOT, "scripts/codex-companion.mjs"),
    "utf8"
  );

  // The runtime default only applies to commands that pin nothing of their own.
  assert.match(runtime, /const DEFAULT_CODEX_MODEL = "gpt-5\.5";/);
  assert.match(runtime, /const DEFAULT_CODEX_REASONING_EFFORT = "high";/);
  assert.match(runtime, /defaultModel: "gpt-5\.6-sol"/);
  assert.match(runtime, /defaultEffort: "medium"/);

  // Every command row in the defaults table.
  assert.match(readme, /\| `\/codex:rescue` \(and delegated tasks\) \| `gpt-5\.5` \| `high` \|/);
  // The two "no effort sent" rows are the subtlest cells in the table, so pin
  // the effort column too rather than stopping after the model.
  assert.match(
    readme,
    /\| `\/codex:review` \| `gpt-5\.5` \| \*\(none sent — `--effort` is rejected\)\* \|/
  );
  assert.match(
    readme,
    /\| `\/codex:adversarial-review` \| `gpt-5\.5` \| \*\(none sent — Codex's own default\)\* \|/
  );
  assert.match(readme, /\| `\/codex:deep-review` \| `gpt-5\.6-sol` \| `medium` \|/);
  assert.match(readme, /\| `\/codex:implement` \| `gpt-5\.6-luna` \| `xhigh` \|/);

  // The old "one global default" claim must not come back.
  assert.doesNotMatch(
    readme,
    /The plugin passes `gpt-5\.5` as the default model and `high` as the default reasoning effort/
  );
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "deep-review.md",
    "implement.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/codex-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Codex's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(codex:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `codex:codex-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "codex:codex-rescue"/);
  assert.match(rescue, /do not call `Skill\(codex:codex-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|spark>/);
  assert.match(rescue, /--effort <none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Codex thread/);
  assert.match(rescue, /Start a new Codex thread/);
  assert.match(rescue, /run the `codex:codex-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--effort` are runtime-selection flags/i);
  assert.match(rescue, /runtime defaults to `high`/i);
  assert.match(rescue, /If they ask for `spark`, map it to `gpt-5\.3-codex-spark`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new thread, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Codex companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Codex running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `deep-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /runtime defaults to `high`/i);
  assert.match(agent, /runtime defaults to `gpt-5\.5`/i);
  assert.match(agent, /If the user asks for `spark`, map that to `--model gpt-5\.3-codex-spark`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `gpt-5\.4-mini`, pass it through with `--model`/i);
  assert.match(agent, /Return the stdout of the `codex-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(agent, /gpt-5-4-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Codex prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `deep-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /runtime defaults to `high`/i);
  assert.match(runtimeSkill, /runtime defaults to `gpt-5\.5`/i);
  assert.match(runtimeSkill, /Map `spark` to `--model gpt-5\.3-codex-spark`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /codex-companion\.mjs" task \[--write\] \[--model <m>\] \[--effort <e>\] \[--resume-last\|--fresh\] -- "<prompt text>"/);
  assert.match(runtimeSkill, /The bare `--` guarantees the prompt reaches Codex verbatim even when its first word is a flag name like `--write`/i);
  assert.match(runtimeSkill, /flags first, then a bare `--`, then the prompt/i);
  assert.match(runtimeSkill, /`--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Codex cannot be invoked, return nothing/i);
  assert.match(readme, /`codex:codex-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--effort`, `\/codex:rescue` uses `gpt-5\.5` with `high` reasoning effort/i);
  assert.match(readme, /--model gpt-5\.4-mini --effort medium/i);
  assert.match(readme, /`spark`, the plugin maps that to `gpt-5\.3-codex-spark`/i);
  assert.match(readme, /continue a previous Codex task/i);
  assert.match(
    readme,
    /for `task` and the review commands, flags must precede the prompt\/focus text \(anything after it is literal, not a flag\); `\/codex:status`, `\/codex:result`, and `\/codex:cancel` instead take their job id first and flags after/i
  );
  assert.match(readme, /a prompt whose \*first\* word is a flag name must be passed after a bare `--` \(for example, `task -- --write access is missing`\), otherwise it is consumed as a real flag/i);
  assert.match(readme, /### `\/codex:setup`/);
  assert.match(readme, /### `\/codex:review`/);
  assert.match(readme, /### `\/codex:adversarial-review`/);
  assert.match(readme, /### `\/codex:deep-review`/);
  assert.match(readme, /uses the same review target selection as `\/codex:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/codex:rescue`/);
  assert.match(readme, /### `\/codex:transfer`/);
  assert.match(readme, /### `\/codex:status`/);
  assert.match(readme, /### `\/codex:result`/);
  assert.match(readme, /### `\/codex:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/codex-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /codex-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /codex resume <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /codex-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /codex-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Codex run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Codex was never successfully invoked, do not generate a substitute answer at all/i);
});

test("review commands are invocable by controller agents", () => {
  const review = read("commands/review.md");
  const adversarialReview = read("commands/adversarial-review.md");
  const deepReview = read("commands/deep-review.md");

  assert.doesNotMatch(review, /disable-model-invocation/);
  assert.doesNotMatch(adversarialReview, /disable-model-invocation/);
  assert.doesNotMatch(deepReview, /disable-model-invocation/);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/codex-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gpt-5-4-prompting/SKILL.md");
  const promptRecipes = read("skills/gpt-5-4-prompting/references/codex-prompt-recipes.md");

  assert.match(runtimeSkill, /codex-companion\.mjs" task \[--write\] \[--model <m>\] \[--effort <e>\] \[--resume-last\|--fresh\] -- "<prompt text>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Codex task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Codex task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Codex install and still points users to codex login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /codex-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!codex login/);
  assert.match(readme, /offer to install Codex for you/i);
  assert.match(readme, /\/codex:setup --enable-review-gate/);
  assert.match(readme, /\/codex:setup --disable-review-gate/);
});

test("the follow-through mechanism is actually provisioned on every command that requires it", () => {
  // The pre-change prose said "Do not call `BashOutput`", so omitting it from
  // allowed-tools was consistent. Now that the follow-through depends on it,
  // an unprovisioned command fails closed at exactly the moment it used to
  // hand the user a checkpoint -- and the old escape hatch is gone.
  for (const file of [
    "commands/review.md",
    "commands/adversarial-review.md",
    "commands/deep-review.md",
    "commands/implement.md"
  ]) {
    const source = read(file);
    const frontmatter = source.slice(0, source.indexOf("\n---", 4));
    const allowed = /^allowed-tools:(.*)$/m.exec(frontmatter);
    assert.ok(allowed, `${file} declares allowed-tools`);
    assert.match(allowed[1], /\bBashOutput\b/, `${file} may call BashOutput`);
    assert.match(source, /`BashOutput`/, `${file} names BashOutput as the read mechanism`);
  }
});

test("no command tells the model to wait via a command it cannot invoke", () => {
  // status.md is disable-model-invocation: true, so "/codex:status" is advice
  // for a human. A flow that names it as *its own* wait mechanism dead-ends.
  const status = read("commands/status.md");
  assert.match(status, /^disable-model-invocation:\s*true$/m);

  for (const file of [
    "commands/review.md",
    "commands/adversarial-review.md",
    "commands/deep-review.md",
    "commands/implement.md",
    "commands/rescue.md"
  ]) {
    const source = read(file);
    for (const line of source.split("\n")) {
      if (!/\/codex:status/.test(line)) continue;
      // Naming it is fine only while telling the model NOT to route through it.
      assert.match(
        line,
        /\bnever\b|\bnot\b|\bno\b|nothing to show/i,
        `${file} must not offer /codex:status as its own wait mechanism: ${line.trim()}`
      );
    }
  }
});

test("dispatch is never a stopping point across every async surface", () => {
  // Regression for the "dispatched, then ended the turn" failure mode: the
  // background flows used to end at "Check /codex:status for progress", which
  // trained the controller to hand the user a checkpoint instead of the result.
  for (const file of ["commands/review.md", "commands/adversarial-review.md", "commands/deep-review.md"]) {
    const source = read(file);
    assert.match(source, /re-invokes you when the command exits/i);
    assert.match(source, /second half of this command/i);
    assert.match(source, /present the review in that same turn/i);
    assert.match(source, /never re-dispatch a second review/i);
    // Broad enough to catch near-miss regressions of the old dead end.
    assert.doesNotMatch(source, /Check .{0,4}\/codex:status.{0,4} for /i);
  }

  const rescue = read("commands/rescue.md");
  assert.match(rescue, /backgrounds the \*subagent\*, not the Codex run/i);
  assert.match(rescue, /Do not close out a turn with a dispatched-but-unread rescue/i);

  const implement = read("commands/implement.md");
  assert.match(implement, /## Dispatch and Follow-Through/);
  assert.match(implement, /\*\*"Dispatched" is never a stopping point\.\*\*/);
  assert.match(implement, /having to be prompted to resume the loop is a failure of this command/i);
  // The harness timeout is a moving harness constant; do not pin its value.
  assert.doesNotMatch(implement, /caps at \d+ ms/);
});

test("implement never passes --wait to task, which is redundant with its foreground default", () => {
  // `handleTask` declares `wait` as an accepted no-op boolean (foreground is
  // already `task`'s default; see #46), so SDD dispatches don't need it.
  const implement = read("commands/implement.md");
  for (const line of implement.split("\n")) {
    if (!/codex-companion\.mjs" task /.test(line)) continue;
    assert.doesNotMatch(line, /\s--wait\b/, `task invocation must not pass --wait: ${line.trim()}`);
  }

  const companion = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs"), "utf8");
  const taskOptions = /booleanOptions: \["json", "write", "resume-last", "resume", "fresh", "background", "wait"\]/;
  assert.match(companion, taskOptions, "task's boolean options should include `wait`");
});

test("status documents the job-scoped wait without hardcoding runtime values", () => {
  const status = read("commands/status.md");
  const companion = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs"), "utf8");

  assert.match(status, /status <job-id> --wait --json/);
  assert.match(status, /`--wait` requires a job ID/i);
  assert.match(status, /Never hand-roll a poll loop/i);
  assert.match(status, /Only `task --background` mints a job ID/i);

  // waitTimedOut only reaches the caller through --json: the text renderer is
  // handed snapshot.job, and the wrapper carrying the flag is discarded.
  assert.match(status, /waitTimedOut: true/);
  assert.match(status, /--json/);
  assert.match(companion, /waitTimedOut: isActiveJobStatus\(snapshot\.job\.status\)/);

  // Pin the constant by name, not by value, so the doc cannot silently rot.
  assert.match(status, /DEFAULT_STATUS_WAIT_TIMEOUT_MS/);
  assert.match(companion, /const DEFAULT_STATUS_WAIT_TIMEOUT_MS = \d+;/);
  assert.doesNotMatch(status, /default timeout is \d+ ms/i);

  // The status vocabulary the doc warns about must match what the runtime emits.
  for (const emitted of ["queued", "running", "completed", "failed", "cancelled"]) {
    assert.ok(status.includes(emitted), `status.md names the real "${emitted}" status`);
  }
  assert.doesNotMatch(companion, /status: "succeeded"/);

  // The queued-launch line must hand the model a command it can actually run.
  assert.match(companion, /codex-companion\.mjs status \$\{payload\.jobId\} --wait --json/);
});

test("every command that returns stdout verbatim also surfaces the [codex] stderr notice", () => {
  // The warning for a flag typed after the prompt goes to stderr, but these
  // docs tell Claude to return stdout only -- without this bullet the notice
  // never reaches the user on the path it exists for. See #46 round 3.
  for (const name of ["review.md", "adversarial-review.md", "deep-review.md"]) {
    const doc = read(`commands/${name}`);
    assert.match(
      doc,
      /If the command prints a `\[codex\] ` line on stderr, surface that line above the output/i,
      `${name} must tell Claude to surface the [codex] stderr notice`
    );
  }

  const agent = fs.readFileSync(path.join(PLUGIN_ROOT, "agents", "codex-rescue.md"), "utf8");
  assert.match(agent, /If the command prints a `\[codex\] ` line on stderr, surface that line above the output/i);
  // "return nothing" on failure must not swallow a rejected-argument error.
  assert.match(agent, /Unknown option: \.\.\.`\), which is a caller mistake and must be reported/i);
});

test("implement backgrounds every long Codex dispatch, including final review and single-shot", () => {
  // See #42. The controller is Claude Code, whose foreground Bash call is
  // killed at the harness ceiling. `review` and a non-`--background` `task`
  // both run in the foreground inside the script (handleReviewCommand and
  // handleTask call runForegroundCommand), so detaching is the caller's job.
  // Every dispatch site must point at Dispatch and Follow-Through, not just
  // the per-task implementer.
  const implement = read("commands/implement.md");

  const finalReview = implement.slice(implement.indexOf("## Final Review"), implement.indexOf("## Aggregated Report"));
  assert.ok(finalReview.includes("codex-companion.mjs\" review"), "final review section still dispatches a review");
  assert.match(finalReview, /Dispatch and Follow-Through/);
  assert.doesNotMatch(finalReview, /\s--wait\b/, "review runs in the foreground already; --wait cannot detach it");

  const singleShot = implement.slice(implement.indexOf("## Single-Shot Mode"), implement.indexOf("## Argument and Flag Reference"));
  assert.ok(singleShot.includes("codex-companion.mjs\" task"), "single-shot section still dispatches a task");
  assert.match(singleShot, /Dispatch and Follow-Through/);
});

test("implement documents how to recover a dispatch the harness killed", () => {
  // See #42. A killed run loses the report, never the edits: Codex writes to
  // the worktree as it goes, and runTrackedJob's signal handler leaves the
  // failed record carrying the threadId it had when it died (covered by
  // runtime.test.mjs's SIGTERM test). Without this, the controller re-dispatches
  // fresh on top of half-finished work.
  const implement = read("commands/implement.md");
  const dispatch = implement.slice(
    implement.indexOf("## Dispatch and Follow-Through"),
    implement.indexOf("## Task Extraction")
  );

  assert.match(dispatch, /killed/i);
  // The recovery handle: read the dead job's thread id back, then resume it.
  assert.match(dispatch, /threadId/);
  assert.match(dispatch, /--resume-id/);
  // The reassurance that stops a destructive re-dispatch.
  assert.match(dispatch, /already on disk|edits are not lost|never the work/i);
});

test("implement scopes kill-recovery to task threads, since review threads are ephemeral", () => {
  // Deep review of #42's fix: the recovery bullet sits in the section that
  // governs every dispatch, but only `task` threads survive to be resumed.
  // `executeTaskRun` passes `persistThread: true`; `runAppServerReview` starts
  // its thread with a hardcoded `ephemeral: true`, so a killed final review has
  // no thread to resume -- it must be re-dispatched instead.
  const implement = read("commands/implement.md");
  const dispatch = implement.slice(
    implement.indexOf("## Dispatch and Follow-Through"),
    implement.indexOf("## Task Extraction")
  );

  // Resume is for `task` dispatches specifically, not "a dispatch".
  assert.match(dispatch, /`task` dispatch/i);
  // A killed native review gets re-dispatched, and the doc says why.
  assert.match(dispatch, /ephemeral/i);
  assert.match(dispatch, /re-?dispatch (the|a) (final )?review|dispatch a fresh review/i);

  // The lead-in must not still claim a kill loses the work; the bullet says the
  // opposite, and the bullet is the accurate one for a `--write` task.
  const leadIn = dispatch.slice(0, dispatch.indexOf("\n- "));
  assert.doesNotMatch(leadIn, /lose the work/i);

  // Pin the two runtime facts the guidance rests on.
  const codex = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "lib", "codex.mjs"), "utf8");
  const companion = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs"), "utf8");
  assert.match(companion, /persistThread: true/, "task runs must still persist their thread");
  const reviewStart = codex.slice(codex.indexOf("export async function runAppServerReview"));
  assert.match(
    reviewStart.slice(0, reviewStart.indexOf("const sourceThreadId")),
    /ephemeral: true/,
    "review runs must still start an ephemeral thread"
  );
});
